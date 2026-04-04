package shares

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

// Mailer is the subset of smtp.Mailer used by this package.
type Mailer interface {
	SendShareNotification(ctx context.Context, toEmail, sharerName, fileName, appURL string) error
	SendShareInvite(ctx context.Context, toEmail, sharerName, fileName, inviteLink string) error
}

// Handler provides HTTP handlers for file sharing.
type Handler struct {
	db     *pgxpool.Pool
	mailer Mailer
	appURL string // base URL of the app, e.g. "https://sharedrive.example.com"
}

func NewHandler(db *pgxpool.Pool, mailer Mailer, appURL string) *Handler {
	return &Handler{db: db, mailer: mailer, appURL: appURL}
}

type Share struct {
	ID               string     `json:"id"`
	ResourceID       string     `json:"resource_id"`
	OwnerID          string     `json:"owner_id"`
	GranteeType      string     `json:"grantee_type"`
	GranteeID        *string    `json:"grantee_id,omitempty"`
	GranteeEmail     *string    `json:"grantee_email,omitempty"`
	GranteeGroupName *string    `json:"grantee_group_name,omitempty"`
	PendingEmail     *string    `json:"pending_email,omitempty"`
	Token            *string    `json:"token,omitempty"`
	CanView          bool       `json:"can_view"`
	CanUpload        bool       `json:"can_upload"`
	CanEdit          bool       `json:"can_edit"`
	CanDelete        bool       `json:"can_delete"`
	CanReshare       bool       `json:"can_reshare"`
	ExpiresAt        *time.Time `json:"expires_at,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
}

type createShareRequest struct {
	ResourceID   string     `json:"resource_id"`
	GranteeType  string     `json:"grantee_type"` // "user", "group", or "link"
	GranteeEmail string     `json:"grantee_email"` // resolved to UUID for type=user
	GranteeID    string     `json:"grantee_id"`    // UUID; used directly for group, or looked up for user
	CanView      bool       `json:"can_view"`
	CanUpload    bool       `json:"can_upload"`
	CanEdit      bool       `json:"can_edit"`
	CanDelete    bool       `json:"can_delete"`
	CanReshare   bool       `json:"can_reshare"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
}

type updateShareRequest struct {
	CanView    *bool      `json:"can_view"`
	CanUpload  *bool      `json:"can_upload"`
	CanEdit    *bool      `json:"can_edit"`
	CanDelete  *bool      `json:"can_delete"`
	CanReshare *bool      `json:"can_reshare"`
	ExpiresAt  *time.Time `json:"expires_at"`
}

// List handles GET /api/v1/shares — returns shares created by the current user,
// optionally filtered by ?resource_id=<uuid>.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	resourceID := r.URL.Query().Get("resource_id")

	query := `SELECT s.id, s.resource_id, s.owner_id, s.grantee_type, s.grantee_id,
	                 s.can_view, s.can_upload, s.can_edit, s.can_delete, s.can_reshare,
	                 s.expires_at, s.created_at,
	                 u.email AS grantee_email,
	                 g.name  AS grantee_group_name,
	                 s.pending_email,
	                 s.token
	          FROM shares s
	          LEFT JOIN users  u ON s.grantee_type = 'user'  AND u.id = s.grantee_id
	          LEFT JOIN groups g ON s.grantee_type = 'group' AND g.id = s.grantee_id
	          WHERE s.owner_id = $1 AND s.revoked_at IS NULL`
	args := []any{u.ID}
	if resourceID != "" {
		query += " AND s.resource_id = $2"
		args = append(args, resourceID)
	}
	query += " ORDER BY s.created_at DESC"

	rows, err := h.db.Query(ctx, query, args...)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	var out []Share
	for rows.Next() {
		var s Share
		if err := rows.Scan(
			&s.ID, &s.ResourceID, &s.OwnerID, &s.GranteeType, &s.GranteeID,
			&s.CanView, &s.CanUpload, &s.CanEdit, &s.CanDelete, &s.CanReshare,
			&s.ExpiresAt, &s.CreatedAt,
			&s.GranteeEmail, &s.GranteeGroupName, &s.PendingEmail, &s.Token,
		); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if out == nil {
		out = []Share{}
	}
	httputil.Respond(w, http.StatusOK, out)
}

// Create handles POST /api/v1/shares.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req createShareRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.GranteeType != "user" && req.GranteeType != "group" && req.GranteeType != "link" {
		httputil.RespondError(w, http.StatusBadRequest, "grantee_type must be 'user', 'group', or 'link'")
		return
	}

	// For user shares: look up UUID by email if grantee_id not provided.
	var granteeEmail string
	var userNotFound bool
	if req.GranteeType == "user" && req.GranteeID == "" {
		if req.GranteeEmail == "" {
			httputil.RespondError(w, http.StatusBadRequest, "grantee_email is required for user shares")
			return
		}
		err := h.db.QueryRow(ctx,
			`SELECT id, email FROM users WHERE email = lower($1) AND is_active = true`,
			req.GranteeEmail,
		).Scan(&req.GranteeID, &granteeEmail)
		if err != nil {
			// User not found — create a pending share + invitation instead of failing.
			log.Debug().Str("grantee_email", req.GranteeEmail).Msg("share: grantee not found, creating pending share")
			userNotFound = true
		}
	}
	if req.GranteeType != "link" && !userNotFound && req.GranteeID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "grantee_id is required")
		return
	}

	// Verify the resource belongs to this user, also fetch file name for notification.
	var fileName string
	err := h.db.QueryRow(ctx,
		`SELECT name FROM files WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
		req.ResourceID, u.ID,
	).Scan(&fileName)
	if err != nil {
		log.Debug().Err(err).Str("resource_id", req.ResourceID).Msg("share: file lookup failed")
		httputil.RespondError(w, http.StatusNotFound, "file not found")
		return
	}

	// Pending share: grantee has no account yet → create invitation + pending share.
	if userNotFound {
		inviteToken := uuid.New().String()
		inviteHash := hashTokenSHA256(inviteToken)
		_, err := h.db.Exec(ctx,
			`INSERT INTO invitation_tokens (email, token_hash, created_by, expires_at)
			 VALUES (lower($1), $2, $3, now() + interval '7 days')
			 ON CONFLICT DO NOTHING`,
			req.GranteeEmail, inviteHash, u.ID,
		)
		if err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}

		var shareID string
		err = h.db.QueryRow(ctx,
			`INSERT INTO shares (resource_id, owner_id, grantee_type, grantee_id,
			                     can_view, can_upload, can_edit, can_delete, can_reshare,
			                     created_by, expires_at, pending_email)
			 VALUES ($1, $2, 'pending', NULL, $3, $4, $5, $6, $7, $8, $9, lower($10))
			 RETURNING id`,
			req.ResourceID, u.ID,
			req.CanView, req.CanUpload, req.CanEdit, req.CanDelete, req.CanReshare,
			u.ID, req.ExpiresAt, req.GranteeEmail,
		).Scan(&shareID)
		if err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}

		if h.mailer != nil {
			inviteLink := h.appURL + "/accept-invite?token=" + inviteToken
			go func() {
				if err := h.mailer.SendShareInvite(context.Background(), req.GranteeEmail, u.Email, fileName, inviteLink); err != nil {
					log.Warn().Err(err).Str("to", req.GranteeEmail).Msg("share: failed to send share-invite email")
				}
			}()
		}

		httputil.Respond(w, http.StatusCreated, map[string]any{"id": shareID, "pending": true})
		return
	}

	// For link shares, generate a secure random token.
	var linkToken *string
	var granteeIDArg any
	if req.GranteeType == "link" {
		t, err := generateToken()
		if err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}
		linkToken = &t
		granteeIDArg = nil
	} else {
		granteeIDArg = req.GranteeID
	}

	var id string
	err = h.db.QueryRow(ctx,
		`INSERT INTO shares (resource_id, owner_id, grantee_type, grantee_id,
		                     can_view, can_upload, can_edit, can_delete, can_reshare,
		                     created_by, expires_at, token)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		 RETURNING id`,
		req.ResourceID, u.ID, req.GranteeType, granteeIDArg,
		req.CanView, req.CanUpload, req.CanEdit, req.CanDelete, req.CanReshare,
		u.ID, req.ExpiresAt, linkToken,
	).Scan(&id)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Send email notification to the grantee for user shares.
	if req.GranteeType == "user" && granteeEmail != "" && h.mailer != nil {
		sharerName := u.Email
		go func() {
			if err := h.mailer.SendShareNotification(context.Background(), granteeEmail, sharerName, fileName, h.appURL); err != nil {
				log.Warn().Err(err).Str("to", granteeEmail).Msg("failed to send share notification email")
			}
		}()
	}

	resp := map[string]any{"id": id}
	if linkToken != nil {
		resp["token"] = *linkToken
	}
	httputil.Respond(w, http.StatusCreated, resp)
}

// generateToken returns a 32-byte URL-safe random token.
func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// hashTokenSHA256 returns the hex-encoded SHA-256 of a raw token, matching the
// format used by invitation_tokens.
func hashTokenSHA256(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}

// Update handles PATCH /api/v1/shares/{id}.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	shareID := chi.URLParam(r, "id")

	var req updateShareRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}

	// Build dynamic update — only update provided fields
	sets := []string{"expires_at = $2"}
	args := []interface{}{shareID, req.ExpiresAt}
	argN := 3
	boolFields := map[string]*bool{
		"can_view":   req.CanView,
		"can_upload": req.CanUpload,
		"can_edit":   req.CanEdit,
		"can_delete": req.CanDelete,
		"can_reshare": req.CanReshare,
	}
	for col, val := range boolFields {
		if val != nil {
			sets = append(sets, col+" = $"+strconv.Itoa(argN))
			args = append(args, *val)
			argN++
		}
	}
	args = append(args, u.ID)
	ownerArgN := argN

	q := "UPDATE shares SET "
	for i, s := range sets {
		if i > 0 {
			q += ", "
		}
		q += s
	}
	q += " WHERE id = $1 AND owner_id = $" + strconv.Itoa(ownerArgN) + " AND revoked_at IS NULL"

	tag, err := h.db.Exec(ctx, q, args...)
	if err != nil || tag.RowsAffected() == 0 {
		httputil.RespondError(w, http.StatusNotFound, "share not found")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// Revoke handles DELETE /api/v1/shares/{id}.
func (h *Handler) Revoke(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	shareID := chi.URLParam(r, "id")
	tag, err := h.db.Exec(ctx,
		`UPDATE shares SET revoked_at = now()
		 WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL`,
		shareID, u.ID,
	)
	if err != nil || tag.RowsAffected() == 0 {
		httputil.RespondError(w, http.StatusNotFound, "share not found")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// SharedWithMe handles GET /api/v1/files/shared-with-me.
func (h *Handler) SharedWithMe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	rows, err := h.db.Query(ctx,
		`SELECT s.id, s.resource_id, s.owner_id, s.grantee_type, s.grantee_id,
		        s.can_view, s.can_upload, s.can_edit, s.can_delete, s.can_reshare,
		        s.expires_at, s.created_at
		 FROM shares s
		 WHERE s.revoked_at IS NULL
		   AND (s.expires_at IS NULL OR s.expires_at > now())
		   AND (
		     (s.grantee_type = 'user' AND s.grantee_id = $1)
		     OR
		     (s.grantee_type = 'group' AND s.grantee_id IN (
		       SELECT group_id FROM group_members WHERE user_id = $1
		     ))
		   )
		 ORDER BY s.created_at DESC`,
		u.ID,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	var out []Share
	for rows.Next() {
		var s Share
		if err := rows.Scan(
			&s.ID, &s.ResourceID, &s.OwnerID, &s.GranteeType, &s.GranteeID,
			&s.CanView, &s.CanUpload, &s.CanEdit, &s.CanDelete, &s.CanReshare,
			&s.ExpiresAt, &s.CreatedAt,
		); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if out == nil {
		out = []Share{}
	}
	httputil.Respond(w, http.StatusOK, out)
}

// SharedByLink handles GET /api/v1/public/shared/{token} — unauthenticated.
func (h *Handler) SharedByLink(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := chi.URLParam(r, "token")
	if token == "" {
		httputil.RespondError(w, http.StatusBadRequest, "missing token")
		return
	}

	type payload struct {
		Share Share  `json:"share"`
		Name  string `json:"name"`
		Size  int64  `json:"size"`
		Mime  string `json:"mime"`
	}

	var p payload
	err := h.db.QueryRow(ctx,
		`SELECT s.id, s.resource_id, s.owner_id, s.grantee_type,
		        s.can_view, s.can_upload, s.can_edit, s.can_delete, s.can_reshare,
		        s.expires_at, s.created_at, s.token,
		        f.name, f.size, COALESCE(f.mime_type, 'application/octet-stream')
		 FROM shares s
		 JOIN files f ON f.id = s.resource_id
		 WHERE s.token = $1
		   AND s.revoked_at IS NULL
		   AND (s.expires_at IS NULL OR s.expires_at > now())
		   AND f.deleted_at IS NULL`,
		token,
	).Scan(
		&p.Share.ID, &p.Share.ResourceID, &p.Share.OwnerID, &p.Share.GranteeType,
		&p.Share.CanView, &p.Share.CanUpload, &p.Share.CanEdit, &p.Share.CanDelete, &p.Share.CanReshare,
		&p.Share.ExpiresAt, &p.Share.CreatedAt, &p.Share.Token,
		&p.Name, &p.Size, &p.Mime,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusNotFound, "share not found")
		return
	}
	httputil.Respond(w, http.StatusOK, p)
}

