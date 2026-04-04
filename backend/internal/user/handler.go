package user

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/alexedwards/argon2id"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/httputil"
)

// Handler provides HTTP handlers for admin user management.
type Handler struct {
	db       *pgxpool.Pool
	auditSvc audit.Logger
}

// NewHandler creates a Handler.
func NewHandler(db *pgxpool.Pool, auditSvc audit.Logger) *Handler {
	return &Handler{db: db, auditSvc: auditSvc}
}

// List handles GET /api/v1/admin/users
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	perPage := 50
	offset := (page - 1) * perPage

	users, total, err := List(r.Context(), h.db, perPage, offset, false)
	if err != nil {
		log.Error().Err(err).Msg("admin: list users")
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]any{
		"users": users,
		"total": total,
		"page":  page,
	})
}

// Get handles GET /api/v1/admin/users/{id}
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	u, err := FindByID(r.Context(), h.db, id)
	if err != nil || u == nil {
		httputil.RespondError(w, http.StatusNotFound, "user not found")
		return
	}
	httputil.Respond(w, http.StatusOK, u)
}

// createUserRequest is the body for admin-created (invited) users.
type createUserRequest struct {
	Email   string `json:"email"`
	Name    string `json:"name"`
	Role    string `json:"role"`
	QuotaGB int    `json:"quota_gb"`
}

// Create handles POST /api/v1/admin/users — creates an invitation token.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := UserFromContext(ctx)

	var req createUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if req.Email == "" {
		httputil.RespondError(w, http.StatusBadRequest, "email is required")
		return
	}
	if req.Role == "" {
		req.Role = "user"
	}
	quotaBytes := int64(req.QuotaGB) * 1_073_741_824
	if quotaBytes <= 0 {
		quotaBytes = 10_737_418_240 // 10 GB default
	}

	// Generate invite token.
	token := uuid.New().String()
	tokenHash := hashToken(token)
	expiresAt := time.Now().Add(7 * 24 * time.Hour)

	tx, err := h.db.Begin(ctx)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx,
		`INSERT INTO invitation_tokens (email, created_by, token_hash, expires_at)
		 VALUES ($1, $2, $3, $4)`,
		req.Email, actor.ID, tokenHash, expiresAt,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusConflict, "invitation already pending for this email")
		return
	}

	if err := tx.Commit(ctx); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	h.auditSvc.Log(ctx, audit.Event{
		Type:      audit.EventUserCreated,
		ActorID:   &actor.ID,
		IPAddress: r.RemoteAddr,
		Metadata:  map[string]any{"email": req.Email, "role": req.Role},
	})
	httputil.Respond(w, http.StatusCreated, map[string]string{"invite_token": token})
}

// updateUserRequest fields that admin may change.
type updateUserRequest struct {
	Role              *string `json:"role"`
	IsActive          *bool   `json:"is_active"`
	QuotaBytes        *int64  `json:"quota_bytes"`
	WebDAVEnabled     *bool   `json:"webdav_enabled"`
}

// Update handles PATCH /api/v1/admin/users/{id}
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := UserFromContext(ctx)
	id := chi.URLParam(r, "id")

	var req updateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}

	// Build dynamic SET clause.
	sets := []string{"updated_at = now()"}
	args := []any{}
	argN := 1

	if req.Role != nil {
		sets = append(sets, "role = $"+strconv.Itoa(argN))
		args = append(args, *req.Role)
		argN++
	}
	if req.IsActive != nil {
		sets = append(sets, "is_active = $"+strconv.Itoa(argN))
		args = append(args, *req.IsActive)
		argN++
	}
	if req.QuotaBytes != nil {
		sets = append(sets, "quota_bytes = $"+strconv.Itoa(argN))
		args = append(args, *req.QuotaBytes)
		argN++
	}
	if req.WebDAVEnabled != nil {
		sets = append(sets, "webdav_enabled = $"+strconv.Itoa(argN))
		args = append(args, *req.WebDAVEnabled)
		argN++
	}

	args = append(args, id)
	q := "UPDATE users SET " + join(sets, ", ") + " WHERE id = $" + strconv.Itoa(argN)

	if _, err := h.db.Exec(ctx, q, args...); err != nil {
		log.Error().Err(err).Msg("admin: update user")
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	h.auditSvc.Log(ctx, audit.Event{
		Type:      audit.EventUserActivated,
		ActorID:   &actor.ID,
		IPAddress: r.RemoteAddr,
		Metadata:  map[string]any{"target_user_id": id},
	})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// Deactivate handles DELETE /api/v1/admin/users/{id} — sets is_active = false.
func (h *Handler) Deactivate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := UserFromContext(ctx)
	id := chi.URLParam(r, "id")

	if _, err := h.db.Exec(ctx,
		`UPDATE users SET is_active = false, updated_at = now() WHERE id = $1`, id,
	); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Revoke all active sessions.
	if _, err := h.db.Exec(ctx,
		`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, id,
	); err != nil {
		log.Warn().Err(err).Msg("admin: revoke sessions on deactivate")
	}

	h.auditSvc.Log(ctx, audit.Event{
		Type:      audit.EventUserDeactivated,
		ActorID:   &actor.ID,
		IPAddress: r.RemoteAddr,
		Metadata:  map[string]any{"target_user_id": id},
	})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// ListSessions handles GET /api/v1/admin/users/{id}/sessions
func (h *Handler) ListSessions(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	rows, err := h.db.Query(r.Context(),
		`SELECT id, ip_address, user_agent, created_at, expires_at
		 FROM sessions
		 WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
		 ORDER BY created_at DESC`,
		id,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	type sessionRow struct {
		ID        string `json:"id"`
		IP        string `json:"ip_address"`
		UserAgent string `json:"user_agent"`
		CreatedAt string `json:"created_at"`
		ExpiresAt string `json:"expires_at"`
	}
	var sessions []sessionRow
	for rows.Next() {
		var s sessionRow
		if err := rows.Scan(&s.ID, &s.IP, &s.UserAgent, &s.CreatedAt, &s.ExpiresAt); err != nil {
			continue
		}
		sessions = append(sessions, s)
	}
	httputil.Respond(w, http.StatusOK, sessions)
}

// ResetPassword handles POST /api/v1/admin/users/{id}/reset-password — admin sets a new password directly.
func (h *Handler) ResetPassword(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := UserFromContext(ctx)
	id := chi.URLParam(r, "id")

	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Password) < 12 {
		httputil.RespondError(w, http.StatusBadRequest, "password must be at least 12 characters")
		return
	}
	hash, err := argon2id.CreateHash(body.Password, argon2id.DefaultParams)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if _, err := h.db.Exec(ctx,
		`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, hash, id,
	); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	h.auditSvc.Log(ctx, audit.Event{
		Type:      audit.EventPasswordChanged,
		ActorID:   &actor.ID,
		IPAddress: r.RemoteAddr,
		Metadata:  map[string]any{"target_user_id": id, "admin_action": true},
	})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func join(ss []string, sep string) string {
	return strings.Join(ss, sep)
}

// hashToken computes the SHA-256 hex digest of a raw token for DB storage.
func hashToken(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}

// Reinvite handles POST /api/v1/admin/users/{id}/invite — resends an invite email.
func (h *Handler) Reinvite(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := UserFromContext(ctx)
	targetID := chi.URLParam(r, "id")

	// Get the target user's email
	var email string
	if err := h.db.QueryRow(ctx, `SELECT email FROM users WHERE id = $1`, targetID).Scan(&email); err != nil {
		httputil.RespondError(w, http.StatusNotFound, "user not found")
		return
	}

	// Generate a new invitation token (7-day expiry)
	rawToken := uuid.New().String()
	tokenHash := hashToken(rawToken)

	_, err := h.db.Exec(ctx,
		`INSERT INTO invitation_tokens (email, token_hash, created_by, expires_at)
		 VALUES ($1, $2, $3, now() + interval '7 days')`,
		email, tokenHash, actor.ID,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	h.auditSvc.Log(ctx, audit.Event{
		Type:    "USER_REINVITED",
		ActorID: &actor.ID,
		Metadata: map[string]any{
			"target_email": email,
			"target_id":    targetID,
		},
		IPAddress: r.RemoteAddr,
	})

	httputil.Respond(w, http.StatusOK, map[string]any{
		"token": rawToken,
		"email": email,
	})
}

//  Guest management 

// GuestSharedItem is a resource that has been shared with a guest user.
type GuestSharedItem struct {
ResourceID string `json:"resource_id"`
Name       string `json:"name"`
IsFolder   bool   `json:"is_folder"`
OwnerEmail string `json:"owner_email"`
}

// GuestUser is returned by ListGuests.
type GuestUser struct {
ID            string            `json:"id"`
Email         string            `json:"email"`
DisplayName   string            `json:"display_name"`
LastLoginAt   *time.Time        `json:"last_login_at"`
CreatedAt     time.Time         `json:"created_at"`
InvitedByName *string           `json:"invited_by_name"`
SharedItems   []GuestSharedItem `json:"shared_items"`
}

// ListGuests handles GET /api/v1/admin/guests
func (h *Handler) ListGuests(w http.ResponseWriter, r *http.Request) {
ctx := r.Context()

rows, err := h.db.Query(ctx,
`SELECT u.id, u.email, u.display_name, u.last_login_at, u.created_at,
        inviter.display_name
 FROM users u
 LEFT JOIN users inviter ON inviter.id = u.invited_by
 WHERE u.role = 'guest'
 ORDER BY u.created_at DESC`,
)
if err != nil {
httputil.RespondError(w, http.StatusInternalServerError, "internal error")
return
}
defer rows.Close()

guests := []GuestUser{}
for rows.Next() {
var g GuestUser
if err := rows.Scan(&g.ID, &g.Email, &g.DisplayName, &g.LastLoginAt, &g.CreatedAt, &g.InvitedByName); err != nil {
httputil.RespondError(w, http.StatusInternalServerError, "internal error")
return
}
g.SharedItems = []GuestSharedItem{}
guests = append(guests, g)
}
if err := rows.Err(); err != nil {
httputil.RespondError(w, http.StatusInternalServerError, "internal error")
return
}

// Fetch shared items for each guest in a single batched query.
if len(guests) > 0 {
ids := make([]string, len(guests))
for i, g := range guests {
ids[i] = g.ID
}
sRows, err := h.db.Query(ctx,
`SELECT s.grantee_id, f.id, f.name, f.is_folder, owner.email
 FROM shares s
 JOIN files f ON f.id = s.resource_id AND f.deleted_at IS NULL
 JOIN users owner ON owner.id = s.owner_id
 WHERE s.grantee_type = 'user'
   AND s.grantee_id = ANY($1::uuid[])
   AND s.revoked_at IS NULL
   AND (s.expires_at IS NULL OR s.expires_at > now())
 ORDER BY f.name ASC`,
ids,
)
if err == nil {
defer sRows.Close()
itemMap := make(map[string][]GuestSharedItem)
for sRows.Next() {
var granteeID string
var item GuestSharedItem
if err := sRows.Scan(&granteeID, &item.ResourceID, &item.Name, &item.IsFolder, &item.OwnerEmail); err == nil {
itemMap[granteeID] = append(itemMap[granteeID], item)
}
}
for i := range guests {
if items, ok := itemMap[guests[i].ID]; ok {
guests[i].SharedItems = items
}
}
}
}

httputil.Respond(w, http.StatusOK, guests)
}

// PromoteGuest handles POST /api/v1/admin/guests/{id}/promote
// Converts a guest user to a regular user with role='user'.
func (h *Handler) PromoteGuest(w http.ResponseWriter, r *http.Request) {
ctx := r.Context()
actor := UserFromContext(ctx)
id := chi.URLParam(r, "id")

var currentRole string
if err := h.db.QueryRow(ctx, `SELECT role FROM users WHERE id = $1`, id).Scan(&currentRole); err != nil {
httputil.RespondError(w, http.StatusNotFound, "user not found")
return
}
if currentRole != "guest" {
httputil.RespondError(w, http.StatusBadRequest, "user is not a guest")
return
}

if _, err := h.db.Exec(ctx,
`UPDATE users SET role = 'user', updated_at = now() WHERE id = $1`, id,
); err != nil {
httputil.RespondError(w, http.StatusInternalServerError, "internal error")
return
}

h.auditSvc.Log(ctx, audit.Event{
Type:      audit.EventUserActivated,
ActorID:   &actor.ID,
IPAddress: r.RemoteAddr,
Metadata:  map[string]any{"target_user_id": id, "promoted_from_guest": true},
})
httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// DeleteGuest handles DELETE /api/v1/admin/guests/{id}.
// Hard-deletes a guest user: revokes all their shares then removes the user row.
func (h *Handler) DeleteGuest(w http.ResponseWriter, r *http.Request) {
ctx := r.Context()
actor := UserFromContext(ctx)
id := chi.URLParam(r, "id")

var currentRole string
if err := h.db.QueryRow(ctx, `SELECT role FROM users WHERE id = $1`, id).Scan(&currentRole); err != nil {
httputil.RespondError(w, http.StatusNotFound, "user not found")
return
}
if currentRole != "guest" {
httputil.RespondError(w, http.StatusBadRequest, "user is not a guest")
return
}

tx, err := h.db.Begin(ctx)
if err != nil {
httputil.RespondError(w, http.StatusInternalServerError, "internal error")
return
}
defer tx.Rollback(ctx)

// Revoke all shares granted to this guest.
if _, err := tx.Exec(ctx,
`UPDATE shares SET revoked_at = now() WHERE grantee_id = $1 AND revoked_at IS NULL`,
id,
); err != nil {
httputil.RespondError(w, http.StatusInternalServerError, "internal error")
return
}

// Delete the user row.
if _, err := tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, id); err != nil {
httputil.RespondError(w, http.StatusInternalServerError, "internal error")
return
}

if err := tx.Commit(ctx); err != nil {
httputil.RespondError(w, http.StatusInternalServerError, "internal error")
return
}

h.auditSvc.Log(ctx, audit.Event{
Type:     audit.EventUserDeactivated,
ActorID:  &actor.ID,
IPAddress: r.RemoteAddr,
Metadata: map[string]any{"target_user_id": id, "deleted_guest": true},
})
httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}
