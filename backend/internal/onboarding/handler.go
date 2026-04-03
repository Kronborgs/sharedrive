package onboarding

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/alexedwards/argon2id"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/httputil"
)

// Handler handles setup wizard endpoints.
type Handler struct {
	db *pgxpool.Pool
}

// New creates an onboarding Handler.
func New(db *pgxpool.Pool) *Handler {
	return &Handler{db: db}
}

// Status responds with whether first-run setup is still required.
// GET /api/v1/system/onboarding-status
func (h *Handler) Status(w http.ResponseWriter, r *http.Request) {
	var val string
	err := h.db.QueryRow(r.Context(),
		`SELECT value FROM system_settings WHERE key = 'onboarding_complete'`,
	).Scan(&val)
	if err != nil {
		// Table might not exist yet — treat as incomplete.
		httputil.Respond(w, http.StatusOK, map[string]bool{"required": true})
		return
	}
	required := val != "true"
	httputil.Respond(w, http.StatusOK, map[string]bool{"required": required})
}

// setupRequest is the body accepted by POST /api/v1/system/onboarding.
type setupRequest struct {
	SiteName    string `json:"site_name"`
	AdminEmail  string `json:"admin_email"`
	AdminName   string `json:"admin_name"`
	AdminPass   string `json:"admin_password"`
	SMTPHost    string `json:"smtp_host"`
	SMTPPort    int    `json:"smtp_port"`
	SMTPUser    string `json:"smtp_user"`
	SMTPPass    string `json:"smtp_password"`
	SMTPFrom    string `json:"smtp_from"`
	SMTPTLS     string `json:"smtp_tls"`
}

// Setup runs first-time setup: creates the admin account and marks onboarding complete.
// POST /api/v1/system/onboarding
func (h *Handler) Setup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Guard: only allow when not yet complete.
	var currentVal string
	_ = h.db.QueryRow(ctx,
		`SELECT value FROM system_settings WHERE key = 'onboarding_complete'`,
	).Scan(&currentVal)
	if currentVal == "true" {
		httputil.RespondError(w, http.StatusConflict, "setup already completed")
		return
	}

	var req setupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	req.AdminEmail = strings.ToLower(strings.TrimSpace(req.AdminEmail))
	req.AdminName = strings.TrimSpace(req.AdminName)

	if req.AdminEmail == "" || req.AdminName == "" || len(req.AdminPass) < 12 {
		httputil.RespondError(w, http.StatusBadRequest, "admin_email, admin_name and admin_password (min 12 chars) are required")
		return
	}

	hash, err := argon2id.CreateHash(req.AdminPass, argon2id.DefaultParams)
	if err != nil {
		log.Error().Err(err).Msg("onboarding: hash admin password")
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	tx, err := h.db.Begin(ctx)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer tx.Rollback(ctx)

	// Create admin user.
	_, err = tx.Exec(ctx,
		`INSERT INTO users (email, display_name, password_hash, role, quota_bytes)
		 VALUES ($1, $2, $3, 'admin', 107374182400)`, // 100 GB default for admin
		req.AdminEmail, req.AdminName, hash,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusConflict, "admin account already exists")
		return
	}

	// Store site settings.
	if req.SiteName != "" {
		_, _ = tx.Exec(ctx,
			`INSERT INTO system_settings (key, value) VALUES ('app_name', $1)
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
			req.SiteName,
		)
	}

	// Store SMTP settings if provided.
	smtpSettings := map[string]string{}
	if req.SMTPHost != "" {
		smtpSettings["smtp_host"] = req.SMTPHost
		smtpSettings["smtp_port"] = "587"
		smtpSettings["smtp_user"] = req.SMTPUser
		smtpSettings["smtp_from"] = req.SMTPFrom
		smtpSettings["smtp_tls"] = req.SMTPTLS
		if req.SMTPPort != 0 {
			smtpSettings["smtp_port"] = http.StatusText(req.SMTPPort) // won't be used — we persist int as text
		}
	}
	for k, v := range smtpSettings {
		_, _ = tx.Exec(ctx,
			`INSERT INTO system_settings (key, value) VALUES ($1, $2)
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
			k, v,
		)
	}

	// Mark setup complete.
	_, err = tx.Exec(ctx,
		`UPDATE system_settings SET value = 'true', updated_at = now()
		 WHERE key = 'onboarding_complete'`,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if err := tx.Commit(ctx); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	httputil.Respond(w, http.StatusCreated, map[string]bool{"ok": true})
}
