package onboarding

import (
	"compress/gzip"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/alexedwards/argon2id"
	"github.com/jackc/pgx/v5/pgxpool"
	mail "github.com/wneessen/go-mail"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/config"
	"github.com/yourname/privatedrive/internal/httputil"
)

// Handler handles setup wizard endpoints.
type Handler struct {
	db  *pgxpool.Pool
	cfg *config.Config
}

// New creates an onboarding Handler.
func New(db *pgxpool.Pool, cfg *config.Config) *Handler {
	return &Handler{db: db, cfg: cfg}
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

// setupSMTP is the nested SMTP block sent by the setup wizard.
type setupSMTP struct {
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Username    string `json:"username"`
	Password    string `json:"password"`
	FromAddress string `json:"from_address"`
	TLS         bool   `json:"tls"`
}

// setupRequest is the body accepted by POST /api/v1/system/onboarding.
type setupRequest struct {
	SiteName  string     `json:"site_name"`
	AdminEmail string    `json:"admin_email"`
	AdminName  string    `json:"admin_display_name"`
	AdminPass  string    `json:"admin_password"`
	SMTP       *setupSMTP `json:"smtp"`
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
	if req.SMTP != nil && req.SMTP.Host != "" {
		tlsMode := "none"
		if req.SMTP.TLS {
			tlsMode = "starttls"
		}
		smtpSettings := map[string]string{
			"smtp_host":     req.SMTP.Host,
			"smtp_port":     strconv.Itoa(req.SMTP.Port),
			"smtp_user":     req.SMTP.Username,
			"smtp_password": req.SMTP.Password,
			"smtp_from":     req.SMTP.FromAddress,
			"smtp_tls":      tlsMode,
		}
		for k, v := range smtpSettings {
			_, _ = tx.Exec(ctx,
				`INSERT INTO system_settings (key, value) VALUES ($1, $2)
				 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
				k, v,
			)
		}
	}

	// Mark setup complete.
	_, err = tx.Exec(ctx,
		`INSERT INTO system_settings (key, value) VALUES ('onboarding_complete', 'true')
		 ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = now()`,
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

// TestSMTP tests SMTP connectivity during setup, before onboarding is complete.
// POST /api/v1/system/onboarding/smtp-test
func (h *Handler) TestSMTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Host        string `json:"host"`
		Port        int    `json:"port"`
		Username    string `json:"username"`
		Password    string `json:"password"`
		FromAddress string `json:"from_address"`
		ToAddress   string `json:"to_address"`
		TLS         bool   `json:"tls"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Host == "" || req.ToAddress == "" || req.FromAddress == "" {
		httputil.RespondError(w, http.StatusBadRequest, "host, from_address and to_address are required")
		return
	}
	if req.Port == 0 {
		req.Port = 587
	}

	var opts []mail.Option
	opts = append(opts, mail.WithPort(req.Port))
	opts = append(opts, mail.WithTimeout(15*time.Second))
	if req.TLS {
		opts = append(opts, mail.WithTLSPolicy(mail.TLSMandatory))
	} else {
		opts = append(opts, mail.WithTLSPolicy(mail.NoTLS))
	}
	if req.Username != "" {
		opts = append(opts,
			mail.WithUsername(req.Username),
			mail.WithPassword(req.Password),
			mail.WithSMTPAuth(mail.SMTPAuthPlain),
		)
	}

	client, err := mail.NewClient(req.Host, opts...)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, fmt.Sprintf("SMTP client error: %v", err))
		return
	}

	msg := mail.NewMsg()
	if err := msg.From(req.FromAddress); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, fmt.Sprintf("invalid from address: %v", err))
		return
	}
	if err := msg.To(req.ToAddress); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, fmt.Sprintf("invalid to address: %v", err))
		return
	}
	msg.Subject("Sharedrive — SMTP test")
	msg.SetBodyString(mail.TypeTextPlain, "This is an SMTP connectivity test from your Sharedrive setup wizard.")

	if err := client.DialAndSend(msg); err != nil {
		log.Warn().Err(err).Str("host", req.Host).Msg("onboarding: SMTP test failed")
		httputil.RespondError(w, http.StatusBadGateway, fmt.Sprintf("Failed to send: %v", err))
		return
	}

	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// RestoreSetup restores a backup during first-run setup (before onboarding is complete).
// POST /api/v1/system/onboarding/restore
func (h *Handler) RestoreSetup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Guard: only allow when setup is not yet complete.
	var currentVal string
	_ = h.db.QueryRow(ctx,
		`SELECT value FROM system_settings WHERE key = 'onboarding_complete'`,
	).Scan(&currentVal)
	if currentVal == "true" {
		httputil.RespondError(w, http.StatusConflict, "setup already completed — use Admin → Backup to restore")
		return
	}

	if err := r.ParseMultipartForm(64 << 20); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "failed to parse form")
		return
	}
	f, _, err := r.FormFile("backup")
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "missing 'backup' file field")
		return
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "file is not valid gzip")
		return
	}
	defer gz.Close()

	raw, err := io.ReadAll(io.LimitReader(gz, 512<<20))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "failed to decompress backup")
		return
	}

	// We share the same envelope structure as admin/backup.go.
	var env struct {
		Version string `json:"version"`
		HMAC    string `json:"hmac"`
		Data    any    `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid backup JSON")
		return
	}

	// Verify HMAC
	dataJSON, err := json.Marshal(env.Data)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to verify backup")
		return
	}
	mac := hmac.New(sha256.New, []byte(h.cfg.BackupHMACSecret))
	mac.Write(dataJSON)
	expectedSig := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(env.HMAC), []byte(expectedSig)) {
		httputil.RespondError(w, http.StatusBadRequest, "backup HMAC verification failed — wrong BACKUP_HMAC_SECRET or corrupted file")
		return
	}

	// Re-parse data as the full typed structure.
	type backupData struct {
		Users          []map[string]any `json:"users"`
		Groups         []map[string]any `json:"groups"`
		GroupMembers   []map[string]any `json:"group_members"`
		Tags           []map[string]any `json:"tags"`
		Files          []map[string]any `json:"files"`
		FileTags       []map[string]any `json:"file_tags"`
		Shares         []map[string]any `json:"shares"`
		TOTPCreds      []map[string]any `json:"totp_credentials"`
		AppPasswords   []map[string]any `json:"app_passwords"`
		SystemSettings []map[string]any `json:"system_settings"`
	}
	dataBytes, _ := json.Marshal(env.Data)
	var data backupData
	if err := json.Unmarshal(dataBytes, &data); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid backup data")
		return
	}

	tx, err := h.db.Begin(ctx)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	for _, stmt := range []string{
		`DELETE FROM file_tags`,
		`DELETE FROM shares`,
		`DELETE FROM app_passwords`,
		`DELETE FROM totp_credentials`,
		`DELETE FROM group_members`,
		`DELETE FROM tags`,
		`DELETE FROM files`,
		`DELETE FROM groups`,
		`DELETE FROM sessions`,
		`DELETE FROM device_trust_tokens`,
		`DELETE FROM password_reset_tokens`,
		`DELETE FROM invitation_tokens`,
		`DELETE FROM users`,
		`DELETE FROM system_settings`,
	} {
		if _, err := tx.Exec(ctx, stmt); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, fmt.Sprintf("failed to clear table: %v", err))
			return
		}
	}

	insertRows := func(table string, rows []map[string]any) error {
		for _, row := range rows {
			cols := make([]string, 0, len(row))
			placeholders := make([]string, 0, len(row))
			vals := make([]any, 0, len(row))
			i := 1
			for col, val := range row {
				cols = append(cols, col)
				placeholders = append(placeholders, fmt.Sprintf("$%d", i))
				vals = append(vals, val)
				i++
			}
			q := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", table, strings.Join(cols, ", "), strings.Join(placeholders, ", "))
			if _, err := tx.Exec(ctx, q, vals...); err != nil {
				return fmt.Errorf("insert into %s: %w", table, err)
			}
		}
		return nil
	}

	for _, step := range []struct {
		table string
		rows  []map[string]any
	}{
		{"system_settings", data.SystemSettings},
		{"users", data.Users},
		{"groups", data.Groups},
		{"group_members", data.GroupMembers},
		{"tags", data.Tags},
		{"files", data.Files},
		{"file_tags", data.FileTags},
		{"shares", data.Shares},
		{"totp_credentials", data.TOTPCreds},
		{"app_passwords", data.AppPasswords},
	} {
		if err := insertRows(step.table, step.rows); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, fmt.Sprintf("restore failed: %v", err))
			return
		}
	}

	// Ensure onboarding is marked complete after restore.
	if _, err := tx.Exec(ctx,
		`INSERT INTO system_settings (key, value) VALUES ('onboarding_complete', 'true')
		 ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = now()`,
	); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to mark setup complete")
		return
	}

	if err := tx.Commit(ctx); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to commit restore")
		return
	}

	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

