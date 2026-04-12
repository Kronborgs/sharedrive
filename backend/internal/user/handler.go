package user

import (
	"context"
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

// Mailer is the subset of smtp.Mailer used by this package.
type Mailer interface {
	SendInvitation(ctx context.Context, toEmail, inviterName, inviteLink string) error
}

// TOTPManager lets the user admin handler query and revoke TOTP for any user.
type TOTPManager interface {
	HasTOTP(ctx context.Context, userID string) (bool, error)
	Disable(ctx context.Context, userID string) error
}

// clientIP returns the normalised client IP. After the RealIP middleware runs,
// r.RemoteAddr already contains the real client IP.
func clientIP(r *http.Request) string { return r.RemoteAddr }

// Handler provides HTTP handlers for admin user management.
type Handler struct {
	db       *pgxpool.Pool
	auditSvc audit.Logger
	mailer   Mailer
	appURL   string
	totpMgr  TOTPManager // optional, may be nil
}

// NewHandler creates a Handler.
func NewHandler(db *pgxpool.Pool, auditSvc audit.Logger, mailer Mailer, appURL string, totpMgr TOTPManager) *Handler {
	return &Handler{db: db, auditSvc: auditSvc, mailer: mailer, appURL: appURL, totpMgr: totpMgr}
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

	type userWithTOTP struct {
		*User
		TOTPEnabled bool `json:"totp_enabled"`
	}
	items := make([]userWithTOTP, 0, len(users))
	for _, u := range users {
		var enabled bool
		if h.totpMgr != nil {
			enabled, _ = h.totpMgr.HasTOTP(r.Context(), u.ID.String())
		}
		items = append(items, userWithTOTP{User: u, TOTPEnabled: enabled})
	}

	httputil.Respond(w, http.StatusOK, map[string]any{
		"items":       items,
		"total":       total,
		"cursor_next": nil,
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

// createUserRequest is the body for direct admin user creation.
type createUserRequest struct {
	Email       string   `json:"email"`
	DisplayName string   `json:"display_name"`
	Password    string   `json:"password"`
	Role        string   `json:"role"`
	QuotaBytes  int64    `json:"quota_bytes"`
	GroupIDs    []string `json:"group_ids"`
}

// Create handles POST /api/v1/admin/users — creates a user directly with a password.
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
	if len(req.Password) < 8 {
		httputil.RespondError(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}
	if req.Role == "" {
		req.Role = "user"
	}
	if req.DisplayName == "" {
		req.DisplayName = req.Email
	}
	if req.QuotaBytes <= 0 {
		req.QuotaBytes = 10_737_418_240 // 10 GB default
	}

	hash, err := argon2id.CreateHash(req.Password, argon2id.DefaultParams)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	tx, err := h.db.Begin(ctx)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer tx.Rollback(ctx)

	var newID string
	err = tx.QueryRow(ctx,
		`INSERT INTO users (email, display_name, password_hash, role, is_active, quota_bytes)
		 VALUES ($1, $2, $3, $4, true, $5) RETURNING id`,
		req.Email, req.DisplayName, hash, req.Role, req.QuotaBytes,
	).Scan(&newID)
	if err != nil {
		httputil.RespondError(w, http.StatusConflict, "email already in use")
		return
	}

	for _, gid := range req.GroupIDs {
		_, _ = tx.Exec(ctx,
			`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			gid, newID,
		)
	}

	if err := tx.Commit(ctx); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if actor != nil {
		h.auditSvc.Log(ctx, audit.Event{
			Type:       audit.EventUserCreated,
			ActorID:    &actor.ID,
			ActorEmail: actor.Email,
			IPAddress:  clientIP(r),
			Metadata:   map[string]any{"email": req.Email, "role": req.Role},
		})
	}
	httputil.Respond(w, http.StatusCreated, map[string]string{"id": newID})
}

// updateUserRequest fields that admin may change.
type updateUserRequest struct {
	Role               *string `json:"role"`
	IsActive           *bool   `json:"is_active"`
	QuotaBytes         *int64  `json:"quota_bytes"`
	MaxUploadBytes     *int64  `json:"max_upload_bytes"`
	WebDAVEnabled      *bool   `json:"webdav_enabled"`
	TrashRetentionDays *int    `json:"trash_retention_days"`
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
		// Prevent demoting the last admin — require at least one other admin.
		if *req.Role != "admin" {
			var otherAdmins int
			if err := h.db.QueryRow(ctx,
				`SELECT COUNT(*) FROM users WHERE role = 'admin' AND id != $1::uuid`,
				id,
			).Scan(&otherAdmins); err != nil {
				log.Error().Err(err).Msg("admin: check admin count")
				httputil.RespondError(w, http.StatusInternalServerError, "internal error")
				return
			}
			if otherAdmins == 0 {
				httputil.RespondError(w, http.StatusUnprocessableEntity, "cannot demote the last admin — promote another user first")
				return
			}
		}
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
	if req.MaxUploadBytes != nil {
		sets = append(sets, "max_upload_bytes = $"+strconv.Itoa(argN))
		args = append(args, *req.MaxUploadBytes)
		argN++
	}
	if req.WebDAVEnabled != nil {
		sets = append(sets, "webdav_enabled = $"+strconv.Itoa(argN))
		args = append(args, *req.WebDAVEnabled)
		argN++
	}
	if req.TrashRetentionDays != nil {
		sets = append(sets, "trash_retention_days = $"+strconv.Itoa(argN))
		args = append(args, *req.TrashRetentionDays)
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
		Type: func() string {
			if req.QuotaBytes != nil {
				return audit.EventUserQuotaChanged
			}
			return audit.EventUserActivated
		}(),
		ActorID:       &actor.ID,
		IPAddress:     clientIP(r),
		IsAdminAction: true,
		Metadata: func() map[string]any {
			m := map[string]any{"target_user_id": id}
			if req.QuotaBytes != nil {
				m["quota_bytes"] = *req.QuotaBytes
			}
			return m
		}(),
	})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// Lock handles POST /api/v1/admin/users/{id}/lock — sets is_active = false and revokes sessions.
func (h *Handler) Lock(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := UserFromContext(ctx)
	id := chi.URLParam(r, "id")

	if actor != nil && actor.ID.String() == id {
		httputil.RespondError(w, http.StatusBadRequest, "cannot lock your own account")
		return
	}

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
		log.Warn().Err(err).Msg("admin: revoke sessions on lock")
	}

	h.auditSvc.Log(ctx, audit.Event{
		Type:      audit.EventUserDeactivated,
		ActorID:   &actor.ID,
		IPAddress: clientIP(r),
		Metadata:  map[string]any{"target_user_id": id},
	})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// Unlock handles POST /api/v1/admin/users/{id}/unlock — sets is_active = true.
func (h *Handler) Unlock(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := UserFromContext(ctx)
	id := chi.URLParam(r, "id")

	if _, err := h.db.Exec(ctx,
		`UPDATE users SET is_active = true, updated_at = now() WHERE id = $1`, id,
	); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	h.auditSvc.Log(ctx, audit.Event{
		Type:      audit.EventUserActivated,
		ActorID:   &actor.ID,
		IPAddress: clientIP(r),
		Metadata:  map[string]any{"target_user_id": id},
	})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// Delete handles DELETE /api/v1/admin/users/{id} — permanently removes the user and all their data.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := UserFromContext(ctx)
	id := chi.URLParam(r, "id")

	if actor != nil && actor.ID.String() == id {
		httputil.RespondError(w, http.StatusBadRequest, "cannot delete your own account")
		return
	}

	var exists bool
	if err := h.db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, id,
	).Scan(&exists); err != nil || !exists {
		httputil.RespondError(w, http.StatusNotFound, "user not found")
		return
	}

	tx, err := h.db.Begin(ctx)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer tx.Rollback(ctx)

	// Explicitly clean up all FK-constrained rows so the delete works
	// even if ON DELETE CASCADE/SET NULL migrations have not applied yet.
	tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, id)
	tx.Exec(ctx, `DELETE FROM device_trust_tokens WHERE user_id = $1`, id)
	tx.Exec(ctx, `DELETE FROM password_reset_tokens WHERE user_id = $1`, id)
	tx.Exec(ctx, `DELETE FROM totp_credentials WHERE user_id = $1`, id)
	tx.Exec(ctx, `DELETE FROM app_passwords WHERE user_id = $1`, id)
	tx.Exec(ctx, `DELETE FROM bandwidth_usage WHERE user_id = $1`, id)
	tx.Exec(ctx, `UPDATE invitation_tokens SET used_by = NULL WHERE used_by = $1`, id)
	tx.Exec(ctx, `UPDATE invitation_tokens SET created_by = NULL WHERE created_by = $1`, id)
	tx.Exec(ctx, `UPDATE groups SET created_by = NULL WHERE created_by = $1`, id)
	tx.Exec(ctx, `UPDATE tags SET created_by = NULL WHERE created_by = $1`, id)
	tx.Exec(ctx, `UPDATE ip_whitelist SET created_by = NULL WHERE created_by = $1`, id)
	tx.Exec(ctx, `DELETE FROM admin_access_sessions WHERE admin_id = $1 OR target_user_id = $1`, id)
	tx.Exec(ctx, `DELETE FROM group_members WHERE user_id = $1`, id)
	tx.Exec(ctx, `UPDATE shares SET revoked_at = now() WHERE grantee_id = $1 AND revoked_at IS NULL`, id)
	tx.Exec(ctx, `DELETE FROM shares WHERE owner_id = $1 OR created_by = $1`, id)
	tx.Exec(ctx, `DELETE FROM files WHERE owner_id = $1`, id)

	if _, err := tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, id); err != nil {
		log.Error().Err(err).Msg("admin: delete user")
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if err := tx.Commit(ctx); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if actor != nil {
		h.auditSvc.Log(ctx, audit.Event{
			Type:      audit.EventUserDeleted,
			ActorID:   &actor.ID,
			IPAddress: clientIP(r),
			Metadata:  map[string]any{"target_user_id": id},
		})
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// ForcePasswordReset handles POST /api/v1/admin/users/{id}/force-password-reset.
// Sets must_change_password = true and revokes all sessions so the user must
// log in and immediately set a new password.
func (h *Handler) ForcePasswordReset(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := UserFromContext(ctx)
	id := chi.URLParam(r, "id")

	if _, err := h.db.Exec(ctx,
		`UPDATE users SET must_change_password = true, updated_at = now() WHERE id = $1`, id,
	); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Revoke all active sessions so the user must re-login.
	if _, err := h.db.Exec(ctx,
		`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, id,
	); err != nil {
		log.Warn().Err(err).Msg("admin: revoke sessions on force-password-reset")
	}

	if actor != nil {
		h.auditSvc.Log(ctx, audit.Event{
			Type:      audit.EventUserForcedPasswordReset,
			ActorID:   &actor.ID,
			IPAddress: clientIP(r),
			Metadata:  map[string]any{"target_user_id": id},
		})
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// RequireTOTP handles POST /api/v1/admin/users/{id}/require-totp.
// Sets force_totp_setup = true so the user is gated into TOTP setup on next use.
func (h *Handler) RequireTOTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := UserFromContext(ctx)
	id := chi.URLParam(r, "id")

	if _, err := h.db.Exec(ctx,
		`UPDATE users SET force_totp_setup = true, updated_at = now() WHERE id = $1`, id,
	); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if actor != nil {
		h.auditSvc.Log(ctx, audit.Event{
			Type:      audit.EventTOTPEnabled,
			ActorID:   &actor.ID,
			IPAddress: clientIP(r),
			Metadata:  map[string]any{"target_user_id": id, "action": "admin_require_totp"},
		})
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// RevokeTOTP handles DELETE /api/v1/admin/users/{id}/totp.
// Allows an admin to remove TOTP from any user's account.
func (h *Handler) RevokeTOTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := UserFromContext(ctx)
	id := chi.URLParam(r, "id")

	if h.totpMgr == nil {
		httputil.RespondError(w, http.StatusServiceUnavailable, "TOTP not configured")
		return
	}
	if err := h.totpMgr.Disable(ctx, id); err != nil {
		log.Error().Err(err).Msg("admin: revoke user TOTP")
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if actor != nil {
		h.auditSvc.Log(ctx, audit.Event{
			Type:      audit.EventTOTPDisabled,
			ActorID:   &actor.ID,
			IPAddress: clientIP(r),
			Metadata:  map[string]any{"target_user_id": id, "action": "admin_revoke_totp"},
		})
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// UnrequireTOTP handles DELETE /api/v1/admin/users/{id}/require-totp.
// Clears the force_totp_setup flag without disabling existing TOTP.
func (h *Handler) UnrequireTOTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	_, _ = h.db.Exec(ctx,
		`UPDATE users SET force_totp_setup = false, updated_at = now() WHERE id = $1`, id,
	)
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
		IPAddress: clientIP(r),
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
		IPAddress: clientIP(r),
	})

	if h.mailer != nil {
		inviteLink := h.appURL + "/accept-invite?token=" + rawToken
		inviterName := actor.Email
		go func() {
			if err := h.mailer.SendInvitation(context.Background(), email, inviterName, inviteLink); err != nil {
				log.Warn().Err(err).Str("to", email).Msg("reinvite: failed to send invitation email")
			}
		}()
	}

	httputil.Respond(w, http.StatusOK, map[string]any{
		"token": rawToken,
		"email": email,
	})
}

// ─── Guest management ─────────────────────────────────────────────────────────

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
		 WHERE u.role = 'guest' AND u.is_active = true
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
			// Build a map from guestID -> items
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

	// Verify the target is actually a guest.
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
// It revokes the guest's share access and permanently removes the user record.
func (h *Handler) DeleteGuest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := UserFromContext(ctx)
	id := chi.URLParam(r, "id")

	// Verify the target is actually a guest.
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
	tx.Exec(ctx, `UPDATE shares SET revoked_at = now() WHERE grantee_id = $1 AND revoked_at IS NULL`, id)
	// Delete shares owned or created by this guest.
	tx.Exec(ctx, `DELETE FROM shares WHERE owner_id = $1 OR created_by = $1`, id)
	// Revoke sessions (also covered by ON DELETE CASCADE, but be explicit).
	tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, id)
	// Nullify invitation_token references to this guest.
	tx.Exec(ctx, `UPDATE invitation_tokens SET used_by = NULL WHERE used_by = $1`, id)
	// Delete files owned by this guest (uploaded by them into other folders).
	tx.Exec(ctx, `DELETE FROM files WHERE owner_id = $1`, id)
	// Hard-delete the user record.
	if _, err := tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, id); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if err := tx.Commit(ctx); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	h.auditSvc.Log(ctx, audit.Event{
		Type:      audit.EventUserDeactivated,
		ActorID:   &actor.ID,
		IPAddress: r.RemoteAddr,
		Metadata:  map[string]any{"target_user_id": id, "deleted_guest": true},
	})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// RecalculateQuota recomputes quota_used_bytes for a single user from the
// actual non-deleted files in the database, correcting any counter drift.
func (h *Handler) RecalculateQuota(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")

	var before int64
	if err := h.db.QueryRow(ctx, `SELECT quota_used_bytes FROM users WHERE id = $1`, id).Scan(&before); err != nil {
		httputil.RespondError(w, http.StatusNotFound, "user not found")
		return
	}

	_, err := h.db.Exec(ctx, `
		UPDATE users u
		SET quota_used_bytes = COALESCE((
		      SELECT sum(size_bytes)
		      FROM files
		      WHERE owner_id = u.id AND deleted_at IS NULL AND is_folder = false
		    ), 0),
		    updated_at = now()
		WHERE u.id = $1`, id)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "recalculate failed")
		return
	}

	var after int64
	_ = h.db.QueryRow(ctx, `SELECT quota_used_bytes FROM users WHERE id = $1`, id).Scan(&after)

	log.Info().Str("user_id", id).Int64("before_bytes", before).Int64("after_bytes", after).Msg("admin: quota recalculated")
	httputil.Respond(w, http.StatusOK, map[string]any{"before_bytes": before, "after_bytes": after})
}
