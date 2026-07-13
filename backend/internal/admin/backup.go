package admin

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/yourname/privatedrive/internal/httputil"
)

// ── Backup envelope ───────────────────────────────────────────────────────────

const backupVersion = "1"

const backupFileSuffix = ".json.gz"

type exportStep struct {
	name  string
	query string
	set   func(*backupData, []map[string]any)
}

var backupExportSteps = []exportStep{
	{name: "users", query: `SELECT id, email, display_name, password_hash, role, is_active, quota_bytes, quota_used_bytes, bandwidth_limit_bytes_per_day, webdav_enabled, invited_by, last_login_at, created_at, updated_at FROM users`, set: func(d *backupData, v []map[string]any) { d.Users = v }},
	{name: "groups", query: `SELECT id, name, description, created_by, created_at FROM groups`, set: func(d *backupData, v []map[string]any) { d.Groups = v }},
	{name: "group_members", query: `SELECT group_id, user_id, added_at FROM group_members`, set: func(d *backupData, v []map[string]any) { d.GroupMembers = v }},
	{name: "tags", query: `SELECT id, name, color, created_by, created_at FROM tags`, set: func(d *backupData, v []map[string]any) { d.Tags = v }},
	{name: "files", query: `SELECT id, parent_id, owner_id, name, is_folder, mime_type, size_bytes, storage_path, checksum_sha256, deleted_at, created_at, updated_at FROM files`, set: func(d *backupData, v []map[string]any) { d.Files = v }},
	{name: "file_tags", query: `SELECT file_id, tag_id FROM file_tags`, set: func(d *backupData, v []map[string]any) { d.FileTags = v }},
	{name: "shares", query: `SELECT id, resource_id, owner_id, grantee_type, grantee_id, can_view, can_upload, can_edit, can_delete, can_reshare, created_by, expires_at, revoked_at, created_at FROM shares`, set: func(d *backupData, v []map[string]any) { d.Shares = v }},
	{name: "totp_credentials", query: `SELECT id, user_id, encrypted_secret, backup_codes, confirmed_at, created_at FROM totp_credentials`, set: func(d *backupData, v []map[string]any) { d.TOTPCreds = v }},
	{name: "app_passwords", query: `SELECT id, user_id, name, password_hash, scope, last_used_at, revoked_at, created_at FROM app_passwords`, set: func(d *backupData, v []map[string]any) { d.AppPasswords = v }},
	{name: "system_settings", query: `SELECT key, value, updated_at FROM system_settings`, set: func(d *backupData, v []map[string]any) { d.SystemSettings = v }},
}

var backupRestoreStatements = []string{
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
}

type backupEnvelope struct {
	Version   string     `json:"version"`
	CreatedAt time.Time  `json:"created_at"`
	HMAC      string     `json:"hmac"`
	Data      backupData `json:"data"`
}

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

// ── Export ────────────────────────────────────────────────────────────────────

// adminExportsDir returns the directory where admin export files are stored.
// Returns ("", false) when no writable backup root can be found.
// Tries cfg.BackupsRoot first, then /mnt/backup as a convention fallback
// (the Unraid template mounts the external disk there).
func (h *Handler) adminExportsDir() (string, bool) {
	candidates := []string{h.cfg.BackupsRoot, "/mnt/backup"}
	for _, p := range candidates {
		if p == "" {
			continue
		}
		info, err := os.Stat(p)
		if err == nil && info.IsDir() {
			return filepath.Join(p, "admin-exports"), true
		}
	}
	return "", false
}

type exportMeta struct {
	Filename  string    `json:"filename"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
	Version   string    `json:"version"`
}

// ListBackups handles GET /api/v1/admin/backup.
// Returns metadata for all saved admin exports, newest first.
func (h *Handler) ListBackups(w http.ResponseWriter, _ *http.Request) {
	dir, ok := h.adminExportsDir()
	if !ok {
		httputil.Respond(w, http.StatusOK, []exportMeta{})
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			httputil.Respond(w, http.StatusOK, []exportMeta{})
			return
		}
		httputil.RespondError(w, http.StatusInternalServerError, "could not read backup directory")
		return
	}

	var result []exportMeta
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), backupFileSuffix) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		result = append(result, exportMeta{
			Filename:  e.Name(),
			SizeBytes: info.Size(),
			CreatedAt: info.ModTime().UTC(),
			Version:   backupVersion,
		})
	}
	// Sort newest first
	sort.Slice(result, func(i, j int) bool {
		return result[i].CreatedAt.After(result[j].CreatedAt)
	})
	httputil.Respond(w, http.StatusOK, result)
}

// DownloadBackup handles GET /api/v1/admin/backup/{filename}/download.
func (h *Handler) DownloadBackup(w http.ResponseWriter, r *http.Request) {
	filename := chi.URLParam(r, "filename")
	if strings.Contains(filename, "..") || strings.Contains(filename, "/") || !strings.HasSuffix(filename, backupFileSuffix) {
		httputil.RespondError(w, http.StatusBadRequest, "invalid filename")
		return
	}
	dir, ok := h.adminExportsDir()
	if !ok {
		httputil.RespondError(w, http.StatusNotFound, "not found")
		return
	}
	path := filepath.Join(dir, filename)
	f, err := os.Open(path) // #nosec G304 — filename validated above
	if err != nil {
		httputil.RespondError(w, http.StatusNotFound, "backup not found")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	_, _ = io.Copy(w, f)
}

// DeleteBackup handles DELETE /api/v1/admin/backup/{filename}.
func (h *Handler) DeleteBackup(w http.ResponseWriter, r *http.Request) {
	filename := chi.URLParam(r, "filename")
	if strings.Contains(filename, "..") || strings.Contains(filename, "/") || !strings.HasSuffix(filename, backupFileSuffix) {
		httputil.RespondError(w, http.StatusBadRequest, "invalid filename")
		return
	}
	dir, ok := h.adminExportsDir()
	if !ok {
		httputil.RespondError(w, http.StatusNotFound, "not found")
		return
	}
	path := filepath.Join(dir, filename)
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			httputil.RespondError(w, http.StatusNotFound, "backup not found")
			return
		}
		httputil.RespondError(w, http.StatusInternalServerError, "delete failed")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// Export streams a gzip-compressed, HMAC-signed JSON backup of all database
// content (metadata only — file blobs are not included).
// The export is also saved to disk so it appears in ListBackups.
func (h *Handler) Export(w http.ResponseWriter, r *http.Request) {
	data, err := h.loadExportData(r.Context())
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Compute HMAC over the data payload
	dataJSON, err := json.Marshal(data)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to serialise backup")
		return
	}
	mac := hmac.New(sha256.New, []byte(h.cfg.BackupHMACSecret))
	mac.Write(dataJSON)
	sig := hex.EncodeToString(mac.Sum(nil))

	envelope := backupEnvelope{
		Version:   backupVersion,
		CreatedAt: time.Now().UTC(),
		HMAC:      sig,
		Data:      data,
	}

	filename := fmt.Sprintf("sharedrive-backup-%s%s", envelope.CreatedAt.Format("2006-01-02T150405Z"), backupFileSuffix)

	// Encode the envelope into an in-memory gzip buffer so we can both save
	// it to disk and stream it to the browser from the same bytes.
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if err := json.NewEncoder(gz).Encode(envelope); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to encode backup")
		return
	}
	if err := gz.Close(); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to finalise backup")
		return
	}

	// Persist to disk when BackupsRoot is configured.
	if dir, ok := h.adminExportsDir(); ok {
		if mkErr := os.MkdirAll(dir, 0o750); mkErr == nil {
			// #nosec G306 — file contains no secrets beyond HMAC-signed data
			_ = os.WriteFile(filepath.Join(dir, filename), buf.Bytes(), 0o640)
		}
	}

	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, &buf)
}

// ── Import / Restore ──────────────────────────────────────────────────────────

// Import restores the database from an uploaded backup file.
// Accepts multipart/form-data with field name "backup".
func (h *Handler) Import(w http.ResponseWriter, r *http.Request) {
	env, status, msg := h.readAndValidateImportEnvelope(r)
	if status != 0 {
		httputil.RespondError(w, status, msg)
		return
	}

	if err := h.restoreEnvelopeData(r.Context(), env); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) queryRows(ctx context.Context, query string, args ...any) ([]map[string]any, error) {
	rows, err := h.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	descs := rows.FieldDescriptions()
	result := make([]map[string]any, 0)
	for rows.Next() {
		vals, scanErr := rows.Values()
		if scanErr != nil {
			return nil, scanErr
		}
		row := make(map[string]any, len(descs))
		for i, d := range descs {
			row[string(d.Name)] = vals[i]
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func (h *Handler) loadExportData(ctx context.Context) (backupData, error) {
	data := backupData{}
	for _, step := range backupExportSteps {
		rows, err := h.queryRows(ctx, step.query)
		if err != nil {
			return backupData{}, fmt.Errorf("failed to export %s", step.name)
		}
		step.set(&data, rows)
	}

	return data, nil
}

func (h *Handler) readAndValidateImportEnvelope(r *http.Request) (backupEnvelope, int, string) {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		return backupEnvelope{}, http.StatusBadRequest, "failed to parse form"
	}

	f, _, err := r.FormFile("backup")
	if err != nil {
		return backupEnvelope{}, http.StatusBadRequest, "missing 'backup' file field"
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return backupEnvelope{}, http.StatusBadRequest, "file is not valid gzip"
	}
	defer gz.Close()

	raw, err := io.ReadAll(io.LimitReader(gz, 512<<20))
	if err != nil {
		return backupEnvelope{}, http.StatusBadRequest, "failed to decompress backup"
	}

	var env backupEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return backupEnvelope{}, http.StatusBadRequest, "invalid backup JSON"
	}
	if env.Version != backupVersion {
		return backupEnvelope{}, http.StatusBadRequest, fmt.Sprintf("unsupported backup version %q", env.Version)
	}

	dataJSON, err := json.Marshal(env.Data)
	if err != nil {
		return backupEnvelope{}, http.StatusInternalServerError, "failed to verify backup"
	}
	mac := hmac.New(sha256.New, []byte(h.cfg.BackupHMACSecret))
	mac.Write(dataJSON)
	expectedSig := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(env.HMAC), []byte(expectedSig)) {
		return backupEnvelope{}, http.StatusBadRequest, "backup HMAC verification failed — wrong BACKUP_HMAC_SECRET or corrupted file"
	}

	return env, 0, ""
}

func (h *Handler) restoreEnvelopeData(ctx context.Context, env backupEnvelope) error {
	tx, err := h.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction")
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := clearBackupRestoreTables(ctx, tx); err != nil {
		return err
	}

	if err := insertEnvelopeRows(ctx, tx, env.Data); err != nil {
		return fmt.Errorf("restore failed: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit restore")
	}

	return nil
}

func clearBackupRestoreTables(ctx context.Context, tx pgx.Tx) error {
	for _, stmt := range backupRestoreStatements {
		if _, err := tx.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("failed to clear table: %v", err)
		}
	}
	return nil
}

func insertEnvelopeRows(ctx context.Context, tx pgx.Tx, data backupData) error {
	allowedColumns := map[string]map[string]bool{
		"system_settings": {"key": true, "value": true, "updated_at": true},
		"users": {
			"id": true, "email": true, "display_name": true, "password_hash": true,
			"role": true, "is_active": true, "quota_bytes": true, "quota_used_bytes": true,
			"bandwidth_limit_bytes_per_day": true, "webdav_enabled": true, "invited_by": true,
			"last_login_at": true, "created_at": true, "updated_at": true,
		},
		"groups":        {"id": true, "name": true, "description": true, "created_by": true, "created_at": true},
		"group_members": {"group_id": true, "user_id": true, "added_at": true},
		"tags":          {"id": true, "name": true, "color": true, "created_by": true, "created_at": true},
		"files": {
			"id": true, "parent_id": true, "owner_id": true, "name": true, "is_folder": true,
			"mime_type": true, "size_bytes": true, "storage_path": true, "checksum_sha256": true,
			"deleted_at": true, "created_at": true, "updated_at": true,
		},
		"file_tags": {"file_id": true, "tag_id": true},
		"shares": {
			"id": true, "resource_id": true, "owner_id": true, "grantee_type": true, "grantee_id": true,
			"can_view": true, "can_upload": true, "can_edit": true, "can_delete": true, "can_reshare": true,
			"created_by": true, "expires_at": true, "revoked_at": true, "created_at": true,
		},
		"totp_credentials": {"id": true, "user_id": true, "encrypted_secret": true, "backup_codes": true, "confirmed_at": true, "created_at": true},
		"app_passwords":    {"id": true, "user_id": true, "name": true, "password_hash": true, "scope": true, "last_used_at": true, "revoked_at": true, "created_at": true},
	}

	type restoreStep struct {
		table string
		rows  []map[string]any
	}
	restoreSteps := []restoreStep{
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
	}

	for _, step := range restoreSteps {
		if err := insertRowsForTable(ctx, tx, step.table, step.rows, allowedColumns[step.table]); err != nil {
			return err
		}
	}

	return nil
}

func insertRowsForTable(
	ctx context.Context,
	tx pgx.Tx,
	table string,
	rows []map[string]any,
	allowed map[string]bool,
) error {
	if allowed == nil {
		return fmt.Errorf("unknown table %q", table)
	}

	for _, row := range rows {
		cols := make([]string, 0, len(row))
		placeholders := make([]string, 0, len(row))
		vals := make([]any, 0, len(row))
		i := 1
		for col, val := range row {
			if !allowed[col] {
				return fmt.Errorf("column %q is not allowed in table %q", col, table)
			}
			cols = append(cols, col)
			placeholders = append(placeholders, fmt.Sprintf("$%d", i))
			vals = append(vals, val)
			i++
		}
		q := fmt.Sprintf(
			"INSERT INTO %s (%s) VALUES (%s)",
			table,
			joinStrings(cols, ", "),
			joinStrings(placeholders, ", "),
		)
		if _, err := tx.Exec(ctx, q, vals...); err != nil {
			return fmt.Errorf("insert into %s: %w", table, err)
		}
	}

	return nil
}

func joinStrings(ss []string, sep string) string {
	result := ""
	for i, s := range ss {
		if i > 0 {
			result += sep
		}
		result += s
	}
	return result
}
