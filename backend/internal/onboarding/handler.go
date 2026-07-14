package onboarding

import (
	"compress/gzip"
	"context"
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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	mail "github.com/wneessen/go-mail"

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

const onboardingErrInternal = "internal error"

func (h *Handler) onboardingComplete(ctx context.Context) bool {
	var currentVal string
	_ = h.db.QueryRow(ctx,
		`SELECT value FROM system_settings WHERE key = 'onboarding_complete'`,
	).Scan(&currentVal)
	return currentVal == "true"
}

func normalizeSetupRequest(req *setupRequest) {
	req.AdminEmail = strings.ToLower(strings.TrimSpace(req.AdminEmail))
	req.AdminName = strings.TrimSpace(req.AdminName)
}

func validSetupRequest(req setupRequest) bool {
	return req.AdminEmail != "" && req.AdminName != "" && len(req.AdminPass) >= 12
}

func smtpSettingsForSetup(smtp *setupSMTP) map[string]string {
	if smtp == nil || smtp.Host == "" {
		return nil
	}

	tlsMode := "none"
	if smtp.TLS {
		tlsMode = "starttls"
	}
	return map[string]string{
		"smtp_host":     smtp.Host,
		"smtp_port":     strconv.Itoa(smtp.Port),
		"smtp_user":     smtp.Username,
		"smtp_password": smtp.Password,
		"smtp_from":     smtp.FromAddress,
		"smtp_tls":      tlsMode,
	}
}

type restoreEnvelope struct {
	Version string `json:"version"`
	HMAC    string `json:"hmac"`
	Data    any    `json:"data"`
}

type restoreBackupData struct {
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

func readRestoreUpload(r *http.Request) ([]byte, int, string) {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		return nil, http.StatusBadRequest, "failed to parse form"
	}
	f, _, err := r.FormFile("backup")
	if err != nil {
		return nil, http.StatusBadRequest, "missing 'backup' file field"
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, http.StatusBadRequest, "file is not valid gzip"
	}
	defer gz.Close()

	raw, err := io.ReadAll(io.LimitReader(gz, 512<<20))
	if err != nil {
		return nil, http.StatusBadRequest, "failed to decompress backup"
	}
	return raw, 0, ""
}

func parseRestoreBackup(raw []byte, secret string) (restoreBackupData, int, string) {
	var env restoreEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return restoreBackupData{}, http.StatusBadRequest, "invalid backup JSON"
	}

	dataJSON, err := json.Marshal(env.Data)
	if err != nil {
		return restoreBackupData{}, http.StatusInternalServerError, "failed to verify backup"
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(dataJSON)
	expectedSig := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(env.HMAC), []byte(expectedSig)) {
		return restoreBackupData{}, http.StatusBadRequest, "backup HMAC verification failed — wrong BACKUP_HMAC_SECRET or corrupted file"
	}

	var data restoreBackupData
	if err := json.Unmarshal(dataJSON, &data); err != nil {
		return restoreBackupData{}, http.StatusBadRequest, "invalid backup data"
	}
	return data, 0, ""
}

func clearRestoreTables(ctx context.Context, tx pgx.Tx) error {
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
			return fmt.Errorf("failed to clear table: %v", err)
		}
	}
	return nil
}

func insertRestoreRows(ctx context.Context, tx pgx.Tx, data restoreBackupData) error {
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
			return fmt.Errorf("restore failed: %v", err)
		}
	}
	return nil
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
	SiteName   string     `json:"site_name"`
	AdminEmail string     `json:"admin_email"`
	AdminName  string     `json:"admin_display_name"`
	AdminPass  string     `json:"admin_password"`
	SMTP       *setupSMTP `json:"smtp"`
}

// Setup runs first-time setup: creates the admin account and marks onboarding complete.
// POST /api/v1/system/onboarding
func (h *Handler) Setup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if h.onboardingComplete(ctx) {
		httputil.RespondError(w, http.StatusConflict, "setup already completed")
		return
	}

	var req setupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	normalizeSetupRequest(&req)
	if !validSetupRequest(req) {
		httputil.RespondError(w, http.StatusBadRequest, "admin_email, admin_name and admin_password (min 12 chars) are required")
		return
	}

	hash, err := argon2id.CreateHash(req.AdminPass, argon2id.DefaultParams)
	if err != nil {
		log.Error().Err(err).Msg("onboarding: hash admin password")
		httputil.RespondError(w, http.StatusInternalServerError, onboardingErrInternal)
		return
	}

	tx, err := h.db.Begin(ctx)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, onboardingErrInternal)
		return
	}
	defer tx.Rollback(ctx)

	if _, err = tx.Exec(ctx,
		`INSERT INTO users (email, display_name, password_hash, role, is_active, quota_bytes)
         VALUES ($1, $2, $3, 'admin', true, 107374182400)`,
		req.AdminEmail, req.AdminName, hash,
	); err != nil {
		httputil.RespondError(w, http.StatusConflict, "admin account already exists")
		return
	}

	if req.SiteName != "" {
		_, _ = tx.Exec(ctx,
			`INSERT INTO system_settings (key, value) VALUES ('app_name', $1)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
			req.SiteName,
		)
	}
	for k, v := range smtpSettingsForSetup(req.SMTP) {
		_, _ = tx.Exec(ctx,
			`INSERT INTO system_settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
			k, v,
		)
	}

	if _, err = tx.Exec(ctx,
		`INSERT INTO system_settings (key, value) VALUES ('onboarding_complete', 'true')
         ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = now()`,
	); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, onboardingErrInternal)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, onboardingErrInternal)
		return
	}

	httputil.Respond(w, http.StatusCreated, map[string]bool{"ok": true})
}

// TestSMTP tests SMTP connectivity during setup, before onboarding is complete.
// POST /api/v1/system/onboarding/smtp-test
func (h *Handler) TestSMTP(w http.ResponseWriter, r *http.Request) {
	// Reject once setup is complete — use the admin SMTP test endpoint instead.
	var onboardingDone string
	_ = h.db.QueryRow(r.Context(),
		`SELECT value FROM system_settings WHERE key = 'onboarding_complete'`,
	).Scan(&onboardingDone)
	if onboardingDone == "true" {
		httputil.RespondError(w, http.StatusForbidden, "setup already complete")
		return
	}

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
		log.Warn().Err(err).Str("host", req.Host).Msg("onboarding: SMTP client init failed")
		httputil.RespondError(w, http.StatusBadRequest, "failed to initialise SMTP client")
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
// RestoreSetup restores a backup during first-run setup (before onboarding is complete).
// POST /api/v1/system/onboarding/restore
func (h *Handler) RestoreSetup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if h.onboardingComplete(ctx) {
		httputil.RespondError(w, http.StatusConflict, "setup already completed — use Admin → Backup to restore")
		return
	}

	raw, status, message := readRestoreUpload(r)
	if status != 0 {
		httputil.RespondError(w, status, message)
		return
	}
	data, status, message := parseRestoreBackup(raw, h.cfg.BackupHMACSecret)
	if status != 0 {
		httputil.RespondError(w, status, message)
		return
	}

	tx, err := h.db.Begin(ctx)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := clearRestoreTables(ctx, tx); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := insertRestoreRows(ctx, tx, data); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, err.Error())
		return
	}

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
