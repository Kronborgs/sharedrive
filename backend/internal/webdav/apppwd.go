package webdav

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/alexedwards/argon2id"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

const appPasswordErrInternal = "internal error"

// AppPasswordHandler provides HTTP handlers for app-password management.
type AppPasswordHandler struct {
	db *pgxpool.Pool
}

func NewAppPasswordHandler(db *pgxpool.Pool) *AppPasswordHandler {
	return &AppPasswordHandler{db: db}
}

// List handles GET /api/v1/me/app-passwords.
func (h *AppPasswordHandler) List(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	rows, err := h.db.Query(ctx,
		`SELECT id, name, scope, resource_id, COALESCE(resource_label,''), last_used_at, created_at
		 FROM app_passwords
		 WHERE user_id = $1 AND revoked_at IS NULL
		 ORDER BY created_at DESC`,
		u.ID,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, appPasswordErrInternal)
		return
	}
	defer rows.Close()
	var out []AppPassword
	for rows.Next() {
		var p AppPassword
		if err := rows.Scan(&p.ID, &p.Name, &p.Scope, &p.ResourceID, &p.ResourceLabel, &p.LastUsedAt, &p.CreatedAt); err != nil {
			continue
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, appPasswordErrInternal)
		return
	}
	if out == nil {
		out = []AppPassword{}
	}
	httputil.Respond(w, http.StatusOK, out)
}

type createAppPasswordRequest struct {
	Name       string  `json:"name"`
	Scope      string  `json:"scope"`
	ResourceID *string `json:"resource_id"` // optional UUID — restricts access to one file/folder
}

type createAppPasswordResponse struct {
	ID            string `json:"id"`
	Password      string `json:"password"` // shown once — plaintext raw token
	ResourceLabel string `json:"resource_label,omitempty"`
}

// Create handles POST /api/v1/me/app-passwords.
func (h *AppPasswordHandler) Create(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req createAppPasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		httputil.RespondError(w, http.StatusBadRequest, "name is required")
		return
	}
	if req.Scope == "" {
		req.Scope = "webdav"
	}

	// If resource_id provided, verify it belongs to the requesting user.
	var resourceLabel string
	if req.ResourceID != nil && *req.ResourceID != "" {
		err := h.db.QueryRow(ctx,
			`SELECT name FROM files WHERE id = $1::uuid AND owner_id = $2::uuid AND deleted_at IS NULL`,
			*req.ResourceID, u.ID,
		).Scan(&resourceLabel)
		if err != nil {
			httputil.RespondError(w, http.StatusBadRequest, "resource not found")
			return
		}
	} else {
		req.ResourceID = nil
	}

	rawToken, err := generateRawToken()
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, appPasswordErrInternal)
		return
	}
	hash, err := argon2id.CreateHash(rawToken, argon2id.DefaultParams)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, appPasswordErrInternal)
		return
	}

	var id string
	if err := h.db.QueryRow(ctx,
		`INSERT INTO app_passwords (user_id, name, password_hash, scope, resource_id, resource_label)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id`,
		u.ID, req.Name, hash, req.Scope, req.ResourceID, resourceLabel,
	).Scan(&id); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, appPasswordErrInternal)
		return
	}

	httputil.Respond(w, http.StatusCreated, createAppPasswordResponse{
		ID:            id,
		Password:      rawToken,
		ResourceLabel: resourceLabel,
	})
}

// Revoke handles DELETE /api/v1/me/app-passwords/{id}.
func (h *AppPasswordHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	id := chi.URLParam(r, "id")
	tag, err := h.db.Exec(ctx,
		`UPDATE app_passwords SET revoked_at = now()
		 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
		id, u.ID,
	)
	if err != nil || tag.RowsAffected() == 0 {
		httputil.RespondError(w, http.StatusNotFound, "app password not found")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// credCache caches recently validated app-password credentials so that argon2id
// does not run on every WebDAV request. This is important for ARM systems where
// argon2id can take 1–3 s per hash, causing Windows WebClient to time out.
//
// Security note: if an app password is revoked it remains valid in cache for up
// to credCacheTTL before the server begins rejecting it. The short TTL limits exposure.
var credCache sync.Map

const credCacheTTL = 5 * time.Minute

type cachedCred struct {
	userID     string
	resourceID *string
	expiresAt  time.Time
}

// credCacheKey returns a SHA-256 hex key for the email+password pair.
// We hash rather than store the raw password as a long-lived map key.
func credCacheKey(email, rawPassword string) string {
	h := sha256.Sum256([]byte(email + ":" + rawPassword))
	return hex.EncodeToString(h[:])
}

// ValidateAppPassword is used by the WebDAV handler to authenticate via basic auth.
// Returns the userID and optional resourceID if the password matches an active app password.
func ValidateAppPassword(ctx context.Context, db *pgxpool.Pool, email, rawPassword string) (userID string, resourceID *string, err error) {
	// Fast path: return cached result to avoid a DB round-trip + argon2id on
	// every WebDAV request. Critical for ARM CPUs where argon2id is 5–10× slower.
	cacheKey := credCacheKey(email, rawPassword)
	if v, ok := credCache.Load(cacheKey); ok {
		c := v.(cachedCred)
		if time.Now().Before(c.expiresAt) {
			return c.userID, c.resourceID, nil
		}
		credCache.Delete(cacheKey) // stale — fall through to full verification
	}

	rows, err := db.Query(ctx,
		`SELECT ap.password_hash, ap.id, u.id::TEXT, ap.resource_id::TEXT
		 FROM app_passwords ap
		 JOIN users u ON u.id = ap.user_id
		 WHERE u.email = $1 AND ap.revoked_at IS NULL AND u.is_active = true`,
		email,
	)
	if err != nil {
		return "", nil, fmt.Errorf("app password: query error")
	}
	defer rows.Close()

	for rows.Next() {
		var hash, apID, uID string
		var resID *string
		if err := rows.Scan(&hash, &apID, &uID, &resID); err != nil {
			continue
		}
		match, err := argon2id.ComparePasswordAndHash(rawPassword, hash)
		if err != nil || !match {
			continue
		}
		// Update last_used_at asynchronously
		go func(id string) {
			_, _ = db.Exec(context.Background(),
				`UPDATE app_passwords SET last_used_at = now() WHERE id = $1`, id)
		}(apID)
		// Cache the result so subsequent requests skip argon2id.
		credCache.Store(cacheKey, cachedCred{
			userID:     uID,
			resourceID: resID,
			expiresAt:  time.Now().Add(credCacheTTL),
		})
		return uID, resID, nil
	}
	return "", nil, fmt.Errorf("app password: invalid credentials")
}

func generateRawToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
