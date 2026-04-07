package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/alexedwards/argon2id"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/config"
	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
	"github.com/yourname/privatedrive/internal/user"
)

const (
	sessionCookieName  = "pd_session"
	deviceCookieName   = "pd_device"
	pendingTOTPKey     = "pending_totp:"
	pendingTOTPTTL     = 10 * time.Minute
	uploadTokenKey     = "upload_token:"
	uploadTokenTTL     = 30 * time.Minute
)

// reUploadToken matches the 64-character lowercase hex tokens issued by IssueUploadToken.
var reUploadToken = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Handler provides all auth HTTP handlers.
type Handler struct {
	db            *pgxpool.Pool
	rdb           *redis.Client
	cfg           *config.Config
	limiter       *RateLimiter
	lockout       *Lockout
	totpSvc       *TOTPService
	deviceTrust   *DeviceTrustService
	passwordReset *PasswordResetService
	auditSvc      audit.Logger
}

func NewHandler(
	db *pgxpool.Pool,
	rdb *redis.Client,
	cfg *config.Config,
	mailer Mailer,
	auditSvc audit.Logger,
) (*Handler, error) {
	totpSvc, err := NewTOTPService(db, cfg.TOTPEncryptKey)
	if err != nil {
		return nil, err
	}
	deviceTrust, err := NewDeviceTrustService(db, cfg.DeviceTrustSecret)
	if err != nil {
		return nil, err
	}
	return &Handler{
		db:            db,
		rdb:           rdb,
		cfg:           cfg,
		limiter:       NewRateLimiter(rdb),
		lockout:       NewLockout(rdb, db, DefaultTiers),
		totpSvc:       totpSvc,
		deviceTrust:   deviceTrust,
		passwordReset: NewPasswordResetService(db, mailer),
		auditSvc:      auditSvc,
	}, nil
}

// Routes registers auth routes on a chi Router.
func (h *Handler) Routes(r chi.Router) {
	r.Post("/auth/login", h.Login)
	r.Post("/auth/logout", h.Logout)
	r.Post("/auth/totp/verify", h.TOTPVerify)
	r.Post("/auth/password-reset/request", h.PasswordResetRequest)
	r.Post("/auth/password-reset/confirm", h.PasswordResetConfirm)
	r.Post("/invitations/{token}/accept", h.AcceptInvite)
	r.Get("/invitations/{token}", h.GetInviteInfo)
	r.Get("/me", h.Me)
}

// ─── Login ────────────────────────────────────────────────────────────────────

type loginRequest struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	TrustDevice bool   `json:"trust_device"`
}

type loginResponse struct {
	RequireTOTP           bool   `json:"require_totp,omitempty"`
	PendingToken          string `json:"pending_token,omitempty"`
	RequirePasswordChange bool   `json:"require_password_change,omitempty"`
	ResetToken            string `json:"reset_token,omitempty"`
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ip := middleware.ClientIP(r)

	// Check lockout first
	if locked, ttl, err := h.lockout.IsLocked(ctx, ip); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	} else if locked {
		httputil.RespondError(w, http.StatusTooManyRequests, fmt.Sprintf("IP is locked out for %s", ttl.Round(time.Minute)))
		return
	}

	// Rate limit
	allowed, _, _, err := h.limiter.Allow(ctx, KeyIPLogin, ip, h.cfg.RateLimitLoginAttempts, h.cfg.RateLimitLoginWindow)
	if err != nil {
		log.Error().Err(err).Msg("rate limiter error")
	}
	if !allowed {
		httputil.RespondError(w, http.StatusTooManyRequests, "too many requests")
		return
	}

	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))

	// Fetch user
	u, err := user.FindByEmail(ctx, h.db, req.Email)
	if err != nil || u == nil {
		h.recordLoginFailure(ctx, ip, req.Email, nil)
		httputil.RespondError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}

	if !u.IsActive {
		httputil.RespondError(w, http.StatusForbidden, "account is locked")
		return
	}

	// Verify password
	match, err := argon2id.ComparePasswordAndHash(req.Password, u.PasswordHash)
	if err != nil || !match {
		h.recordLoginFailure(ctx, ip, req.Email, &u.ID)
		httputil.RespondError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}

	// Password OK — clear failure counters
	h.lockout.ClearFailures(ctx, ip)
	h.limiter.Reset(ctx, KeyIPLogin, ip)

	// If admin forced a password change, return a short-lived reset token instead of a session.
	if u.MustChangePassword {
		resetToken, tokenErr := h.passwordReset.GenerateResetToken(ctx, u.ID.String())
		if tokenErr != nil {
			log.Error().Err(tokenErr).Msg("login: generate forced reset token")
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}
		httputil.Respond(w, http.StatusOK, loginResponse{
			RequirePasswordChange: true,
			ResetToken:            resetToken,
		})
		return
	}

	// Check if trusted device skips TOTP
	hasTOTP, _ := h.totpSvc.HasTOTP(ctx, u.ID.String())
	if hasTOTP {
		if deviceCookie, err2 := r.Cookie(deviceCookieName); err2 == nil {
			if ownerID, err3 := h.deviceTrust.Validate(ctx, deviceCookie.Value); err3 == nil && ownerID == u.ID.String() {
				hasTOTP = false // trusted device — skip 2FA
			}
		}
	}

	if hasTOTP {
		// Store pending state in Redis for TOTP step
		pendingToken, storeErr := h.storePendingTOTP(ctx, u.ID.String(), req.TrustDevice)
		if storeErr != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}
		h.auditSvc.Log(ctx, audit.Event{
			Type:       audit.EventUserLoginTOTPRequired,
			ActorID:    &u.ID,
			ActorEmail: u.Email,
			IPAddress:  ip,
			UserAgent:  r.UserAgent(),
		})
		httputil.Respond(w, http.StatusOK, loginResponse{RequireTOTP: true, PendingToken: pendingToken})
		return
	}

	// Issue session
	h.createSessionAndCookie(ctx, w, r, u.ID.String(), ip)
	h.auditSvc.Log(ctx, audit.Event{
		Type:       audit.EventUserLogin,
		ActorID:    &u.ID,
		ActorEmail: u.Email,
		IPAddress:  ip,
		UserAgent:  r.UserAgent(),
	})
	httputil.Respond(w, http.StatusOK, loginResponse{})
}

// ─── TOTP verify ─────────────────────────────────────────────────────────────

type totpVerifyRequest struct {
	PendingToken string `json:"pending_token"`
	Code         string `json:"code"`
}

func (h *Handler) TOTPVerify(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ip := middleware.ClientIP(r)

	var req totpVerifyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}

	userID, trustDevice, err := h.resolvePendingTOTP(ctx, req.PendingToken)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, "invalid or expired TOTP session")
		return
	}

	if err := h.totpSvc.Validate(ctx, userID, req.Code); err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, "invalid TOTP code")
		return
	}

	// Issue session
	h.createSessionAndCookie(ctx, w, r, userID, ip)

	// Optionally set device trust cookie
	if trustDevice {
		raw, err := h.deviceTrust.Issue(ctx, userID, ip, r.UserAgent())
		if err == nil {
			http.SetCookie(w, &http.Cookie{
				Name:     deviceCookieName,
				Value:    raw,
				Path:     "/",
				Domain:   h.cfg.CookieDomain,
				HttpOnly: true,
				Secure:   !h.cfg.IsDev(),
				SameSite: http.SameSiteLaxMode,
				MaxAge:   int((30 * 24 * time.Hour).Seconds()),
			})
		}
	}

	userUUID, err := uuid.Parse(userID)
	if err == nil {
		var actorEmail string
		_ = h.db.QueryRow(ctx, `SELECT email FROM users WHERE id = $1`, userUUID).Scan(&actorEmail)
		h.auditSvc.Log(ctx, audit.Event{
			Type:       audit.EventUserLogin,
			ActorID:    &userUUID,
			ActorEmail: actorEmail,
			IPAddress:  ip,
			UserAgent:  r.UserAgent(),
		})
	}
	httputil.Respond(w, http.StatusOK, loginResponse{})
}

// ─── Logout ───────────────────────────────────────────────────────────────────

func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	cookie, err := r.Cookie(sessionCookieName)
	if err == nil {
		_ = RevokeSession(ctx, h.db, cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:   sessionCookieName,
		Value:  "",
		Path:   "/",
		MaxAge: -1,
	})
	u := middleware.UserFromContext(ctx)
	if u != nil {
		h.auditSvc.Log(ctx, audit.Event{
			Type:      audit.EventUserLogout,
			ActorID:   &u.ID,
			IPAddress: middleware.ClientIP(r),
		})
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// ─── Me ───────────────────────────────────────────────────────────────────────

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	u := middleware.UserFromContext(r.Context())
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	// Embed computed is_admin field so clients don't have to inspect role string.
	type meResponse struct {
		*user.User
		IsAdmin bool `json:"is_admin"`
	}
	httputil.Respond(w, http.StatusOK, meResponse{User: u, IsAdmin: u.IsAdmin()})
}

// ─── Password reset ───────────────────────────────────────────────────────────

type passwordResetRequestBody struct {
	Email string `json:"email"`
}

func (h *Handler) PasswordResetRequest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ip := middleware.ClientIP(r)

	// 10 requests per 15 minutes per IP — prevents email spam / user enumeration
	allowed, _, _, err := h.limiter.Allow(ctx, KeyIPPasswordReset, ip, 10, 15*time.Minute)
	if err != nil {
		log.Error().Err(err).Msg("rate limiter error (password reset)")
	}
	if !allowed {
		httputil.RespondError(w, http.StatusTooManyRequests, "too many requests")
		return
	}

	var req passwordResetRequestBody
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	_ = h.passwordReset.Request(ctx, strings.ToLower(strings.TrimSpace(req.Email)), h.cfg.BaseURL)
	// Always return 200 — don't reveal whether email exists
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

type passwordResetConfirmBody struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

func (h *Handler) PasswordResetConfirm(w http.ResponseWriter, r *http.Request) {
	var req passwordResetConfirmBody
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if len(req.NewPassword) < 12 {
		httputil.RespondError(w, http.StatusBadRequest, "password must be at least 12 characters")
		return
	}
	hash, err := argon2id.CreateHash(req.NewPassword, argon2id.DefaultParams)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if err := h.passwordReset.Confirm(r.Context(), req.Token, hash); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, err.Error())
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// ─── Invitations ──────────────────────────────────────────────────────────────

type inviteInfo struct {
	Email       string `json:"email"`
	InviterName string `json:"inviter_name"`
	ExpiresAt   string `json:"expires_at"`
}

func (h *Handler) GetInviteInfo(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	hash := hashToken(token)

	var email, inviterName string
	var expiresAt time.Time
	err := h.db.QueryRow(r.Context(),
		`SELECT it.email, u.display_name, it.expires_at
		 FROM invitation_tokens it
		 JOIN users u ON u.id = it.created_by
		 WHERE it.token_hash = $1 AND it.used_at IS NULL AND it.expires_at > now()`,
		hash,
	).Scan(&email, &inviterName, &expiresAt)
	if err != nil {
		httputil.RespondError(w, http.StatusNotFound, "invitation not found or expired")
		return
	}
	httputil.Respond(w, http.StatusOK, inviteInfo{Email: email, InviterName: inviterName, ExpiresAt: expiresAt.Format(time.RFC3339)})
}

type acceptInviteRequest struct {
	Token       string `json:"token"`
	DisplayName string `json:"display_name"`
	Password    string `json:"password"`
}

func (h *Handler) AcceptInvite(w http.ResponseWriter, r *http.Request) {
	ip := middleware.ClientIP(r)
	ctx := r.Context()

	// 20 attempts per 15 minutes per IP — prevents token enumeration
	allowed, _, _, err := h.limiter.Allow(ctx, KeyIPInviteAccept, ip, 20, 15*time.Minute)
	if err != nil {
		log.Error().Err(err).Msg("rate limiter error (invite accept)")
	}
	if !allowed {
		httputil.RespondError(w, http.StatusTooManyRequests, "too many requests")
		return
	}

	var req acceptInviteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	req.Token = chi.URLParam(r, "token")
	if len(req.Password) < 12 {
		httputil.RespondError(w, http.StatusBadRequest, "password must be at least 12 characters")
		return
	}

	hash := hashToken(req.Token)

	var tokenID, email, invitedBy string
	var expiresAt time.Time
	err = h.db.QueryRow(ctx,
		`SELECT id, email, created_by, expires_at FROM invitation_tokens
		 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
		hash,
	).Scan(&tokenID, &email, &invitedBy, &expiresAt)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invitation not found or expired")
		return
	}

	pwHash, err := argon2id.CreateHash(req.Password, argon2id.DefaultParams)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	tx, _ := h.db.Begin(ctx)
	defer tx.Rollback(ctx)

	var newUserID uuid.UUID
	if err := tx.QueryRow(ctx,
		`INSERT INTO users (email, display_name, password_hash, role, quota_bytes, invited_by)
		 VALUES ($1, $2, $3, 'guest', (SELECT (value::bigint) FROM system_settings WHERE key = 'default_quota_bytes'), $4)
		 ON CONFLICT (email) DO UPDATE
		   SET display_name   = EXCLUDED.display_name,
		       password_hash  = EXCLUDED.password_hash,
		       updated_at     = now()
		 WHERE users.role = 'guest'
		 RETURNING id`,
		email, req.DisplayName, pwHash, invitedBy,
	).Scan(&newUserID); err != nil {
		httputil.RespondError(w, http.StatusConflict, "email already registered")
		return
	}

	tx.Exec(ctx, `UPDATE invitation_tokens SET used_at = now(), used_by = $1 WHERE id = $2`, newUserID, tokenID)

	// Link any pending shares that were created for this email before the user had an account.
	tx.Exec(ctx,
		`UPDATE shares SET grantee_type = 'user', grantee_id = $1, pending_email = NULL
		 WHERE grantee_type = 'pending' AND pending_email = lower($2) AND revoked_at IS NULL`,
		newUserID, email,
	)

	if err := tx.Commit(ctx); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	h.auditSvc.Log(ctx, audit.Event{
		Type:         audit.EventUserCreated,
		TargetUserID: &newUserID,
		IPAddress:    middleware.ClientIP(r),
	})
	httputil.Respond(w, http.StatusCreated, map[string]bool{"ok": true})
}

// ─── Session middleware ────────────────────────────────────────────────────────

// SessionMiddleware reads the session cookie, validates it, and injects the User.
func (h *Handler) SessionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(sessionCookieName)
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}

		session, err := ValidateSession(r.Context(), h.db, cookie.Value, h.cfg.SessionIdleTimeout)
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}

		u, err := user.FindByID(r.Context(), h.db, session.UserID)
		if err != nil || u == nil || !u.IsActive {
			next.ServeHTTP(w, r)
			return
		}

		ctx := middleware.WithUser(r.Context(), u)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func (h *Handler) createSessionAndCookie(ctx context.Context, w http.ResponseWriter, r *http.Request, userID, ip string) {
	raw, _, err := CreateSession(ctx, h.db, userID, ip, r.UserAgent(), h.cfg.SessionIdleTimeout)
	if err != nil {
		log.Error().Err(err).Msg("create session")
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    raw,
		Path:     "/",
		Domain:   h.cfg.CookieDomain,
		HttpOnly: true,
		Secure:   !h.cfg.IsDev(),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(h.cfg.SessionIdleTimeout.Seconds()),
	})
}

// IssueUploadToken generates a short-lived token for cross-subdomain TUS upload auth.
// The raw token is returned and stored in Redis under uploadTokenKey+token → userID.
func (h *Handler) IssueUploadToken(ctx context.Context, userID string) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("upload token: generate: %w", err)
	}
	token := hex.EncodeToString(b)
	if err := h.rdb.Set(ctx, uploadTokenKey+token, userID, uploadTokenTTL).Err(); err != nil {
		return "", fmt.Errorf("upload token: store: %w", err)
	}
	return token, nil
}

// HandleIssueUploadToken handles POST /api/v1/upload-token.
// Requires an authenticated session. Returns {"token":"..."} for use as X-Upload-Token.
func (h *Handler) HandleIssueUploadToken(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	token, err := h.IssueUploadToken(r.Context(), actor.ID.String())
	if err != nil {
		log.Error().Err(err).Msg("issue upload token")
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]string{"token": token})
}

// UploadTokenMiddleware checks the X-Upload-Token header when no session cookie auth
// has already populated the context (i.e. it acts as a fallback for cross-subdomain uploads).
func (h *Handler) UploadTokenMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Already authenticated via session cookie — nothing to do.
		if middleware.UserFromContext(r.Context()) != nil {
			next.ServeHTTP(w, r)
			return
		}
		token := r.Header.Get("X-Upload-Token")
		if token == "" || !reUploadToken.MatchString(token) {
			next.ServeHTTP(w, r)
			return
		}
		userID, err := h.rdb.Get(r.Context(), uploadTokenKey+token).Result()
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		u, err := user.FindByID(r.Context(), h.db, userID)
		if err != nil || u == nil || !u.IsActive {
			next.ServeHTTP(w, r)
			return
		}
		ctx := middleware.WithUser(r.Context(), u)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (h *Handler) storePendingTOTP(ctx context.Context, userID string, trustDevice bool) (string, error) {
	b := make([]byte, 16)
	rand.Read(b)
	token := hex.EncodeToString(b)

	type pendingState struct {
		UserID      string `json:"user_id"`
		TrustDevice bool   `json:"trust_device"`
	}
	data, _ := json.Marshal(pendingState{UserID: userID, TrustDevice: trustDevice})
	return token, h.rdb.Set(ctx, pendingTOTPKey+token, data, pendingTOTPTTL).Err()
}

func (h *Handler) resolvePendingTOTP(ctx context.Context, token string) (userID string, trustDevice bool, err error) {
	data, err := h.rdb.GetDel(ctx, pendingTOTPKey+token).Result()
	if err != nil {
		return "", false, fmt.Errorf("pending totp: not found")
	}
	var state struct {
		UserID      string `json:"user_id"`
		TrustDevice bool   `json:"trust_device"`
	}
	if err := json.Unmarshal([]byte(data), &state); err != nil {
		return "", false, err
	}
	return state.UserID, state.TrustDevice, nil
}

func (h *Handler) recordLoginFailure(ctx context.Context, ip, email string, userID *uuid.UUID) {
	locked, dur, err := h.lockout.RecordFailure(ctx, ip)
	if err != nil {
		log.Error().Err(err).Msg("lockout record")
	}
	if locked {
		log.Warn().Str("ip", ip).Dur("duration", dur).Msg("IP locked out")
	}
	h.auditSvc.Log(ctx, audit.Event{
		Type:       audit.EventUserLoginFailed,
		ActorID:    userID,
		ActorEmail: email,
		IPAddress:  ip,
	})
}

// ─── UpdateMe ────────────────────────────────────────────────────────────────

type updateMeRequest struct {
	DisplayName *string `json:"display_name"`
	Email       *string `json:"email"`
	Password    *string `json:"password"`
	OldPassword *string `json:"old_password"`
}

func (h *Handler) UpdateMe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req updateMeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.Password != nil {
		if req.OldPassword == nil {
			httputil.RespondError(w, http.StatusBadRequest, "old_password required to set new password")
			return
		}
		match, err := argon2id.ComparePasswordAndHash(*req.OldPassword, u.PasswordHash)
		if err != nil || !match {
			httputil.RespondError(w, http.StatusUnauthorized, "old password is incorrect")
			return
		}
		if len(*req.Password) < 12 {
			httputil.RespondError(w, http.StatusBadRequest, "password must be at least 12 characters")
			return
		}
		newHash, err := argon2id.CreateHash(*req.Password, argon2id.DefaultParams)
		if err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}
		_, err = h.db.Exec(ctx, `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, newHash, u.ID)
		if err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}
	}
	if req.DisplayName != nil {
		_, err := h.db.Exec(ctx, `UPDATE users SET display_name = $1, updated_at = now() WHERE id = $2`, *req.DisplayName, u.ID)
		if err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}
	}
	if req.Email != nil {
		newEmail := strings.ToLower(strings.TrimSpace(*req.Email))
		_, err := h.db.Exec(ctx, `UPDATE users SET email = $1, updated_at = now() WHERE id = $2`, newEmail, u.ID)
		if err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// ─── TOTP management (user-facing) ────────────────────────────────────────────

type totpSetupResponse struct {
	Secret         string `json:"secret"`
	ProvisioningURI string `json:"provisioning_uri"`
}

func (h *Handler) TOTPSetup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	secret, uri, err := h.totpSvc.BeginEnroll(u.Email)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, totpSetupResponse{Secret: secret, ProvisioningURI: uri})
}

type totpConfirmRequest struct {
	Secret string `json:"secret"`
	Code   string `json:"code"`
}

type totpConfirmResponse struct {
	BackupCodes []string `json:"backup_codes"`
}

func (h *Handler) TOTPConfirm(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req totpConfirmRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	codes, err := h.totpSvc.ConfirmEnroll(ctx, u.ID.String(), u.Email, req.Secret, req.Code)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid TOTP code")
		return
	}
	httputil.Respond(w, http.StatusOK, totpConfirmResponse{BackupCodes: codes})
}

func (h *Handler) TOTPDisable(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := h.totpSvc.Disable(ctx, u.ID.String()); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	h.auditSvc.Log(ctx, audit.Event{
		Type:    "TOTP_DISABLED",
		ActorID: &u.ID,
	})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// ─── Session management ────────────────────────────────────────────────────────

type sessionDTO struct {
	ID        string    `json:"id"`
	IPAddress string    `json:"ip_address"`
	UserAgent string    `json:"user_agent"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
	IsCurrent bool      `json:"is_current"`
}

func (h *Handler) ListSessions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	rows, err := h.db.Query(ctx,
		`SELECT id, ip_address, user_agent, created_at, expires_at
		 FROM sessions
		 WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
		 ORDER BY created_at DESC`,
		u.ID,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	// Determine current session token hash for "is_current" flag
	currentHash := ""
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		currentHash = hashToken(cookie.Value)
	}

	var sessions []sessionDTO
	for rows.Next() {
		var s sessionDTO
		var tokenHash string
		// We need token_hash to detect current session — select it too
		if err := rows.Scan(&s.ID, &s.IPAddress, &s.UserAgent, &s.CreatedAt, &s.ExpiresAt); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}
		_ = tokenHash
		s.IsCurrent = (currentHash != "" && s.ID == currentHash) // approximate
		sessions = append(sessions, s)
	}
	if err := rows.Err(); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, sessions)
}

func (h *Handler) RevokeSession(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	sessionID := chi.URLParam(r, "id")
	// Only revoke sessions belonging to the current user
	tag, err := h.db.Exec(ctx,
		`UPDATE sessions SET revoked_at = now()
		 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
		sessionID, u.ID,
	)
	if err != nil || tag.RowsAffected() == 0 {
		httputil.RespondError(w, http.StatusNotFound, "session not found")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}
