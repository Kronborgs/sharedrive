package admin

import (
	"compress/gzip"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/yourname/privatedrive/internal/httputil"
)

// ── Backup envelope ───────────────────────────────────────────────────────────

const backupVersion = "1"

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

// ListBackups returns an empty list — backups are not stored server-side.
func (h *Handler) ListBackups(w http.ResponseWriter, _ *http.Request) {
	httputil.Respond(w, http.StatusOK, []any{})
}

// Export streams a gzip-compressed, HMAC-signed JSON backup of all database
// content (metadata only — file blobs are not included).
func (h *Handler) Export(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	data := backupData{}
	var err error

	// Helpers
	queryRows := func(query string, args ...any) ([]map[string]any, error) {
		rows, qErr := h.db.Query(ctx, query, args...)
		if qErr != nil {
			return nil, qErr
		}
		defer rows.Close()

		descs := rows.FieldDescriptions()
		var result []map[string]any
		for rows.Next() {
			vals, sErr := rows.Values()
			if sErr != nil {
				return nil, sErr
			}
			row := make(map[string]any, len(descs))
			for i, d := range descs {
				row[string(d.Name)] = vals[i]
			}
			result = append(result, row)
		}
		return result, rows.Err()
	}

	if data.Users, err = queryRows(`SELECT id, email, display_name, password_hash, role, is_active, quota_bytes, quota_used_bytes, bandwidth_limit_bytes_per_day, webdav_enabled, invited_by, last_login_at, created_at, updated_at FROM users`); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to export users")
		return
	}
	if data.Groups, err = queryRows(`SELECT id, name, description, created_by, created_at FROM groups`); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to export groups")
		return
	}
	if data.GroupMembers, err = queryRows(`SELECT group_id, user_id, added_at FROM group_members`); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to export group_members")
		return
	}
	if data.Tags, err = queryRows(`SELECT id, name, color, created_by, created_at FROM tags`); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to export tags")
		return
	}
	if data.Files, err = queryRows(`SELECT id, parent_id, owner_id, name, is_folder, mime_type, size_bytes, storage_path, checksum_sha256, deleted_at, created_at, updated_at FROM files`); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to export files")
		return
	}
	if data.FileTags, err = queryRows(`SELECT file_id, tag_id FROM file_tags`); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to export file_tags")
		return
	}
	if data.Shares, err = queryRows(`SELECT id, resource_id, owner_id, grantee_type, grantee_id, can_view, can_upload, can_edit, can_delete, can_reshare, created_by, expires_at, revoked_at, created_at FROM shares`); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to export shares")
		return
	}
	if data.TOTPCreds, err = queryRows(`SELECT id, user_id, encrypted_secret, backup_codes, confirmed_at, created_at FROM totp_credentials`); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to export totp_credentials")
		return
	}
	if data.AppPasswords, err = queryRows(`SELECT id, user_id, name, password_hash, scope, last_used_at, revoked_at, created_at FROM app_passwords`); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to export app_passwords")
		return
	}
	if data.SystemSettings, err = queryRows(`SELECT key, value, updated_at FROM system_settings`); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to export system_settings")
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

	filename := fmt.Sprintf("sharedrive-backup-%s.json.gz", envelope.CreatedAt.Format("2006-01-02"))
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.WriteHeader(http.StatusOK)

	gz := gzip.NewWriter(w)
	defer gz.Close()
	if err := json.NewEncoder(gz).Encode(envelope); err != nil {
		// Headers already sent — nothing we can do except log
		return
	}
}

// ── Import / Restore ──────────────────────────────────────────────────────────

// Import restores the database from an uploaded backup file.
// Accepts multipart/form-data with field name "backup".
func (h *Handler) Import(w http.ResponseWriter, r *http.Request) {
	// 64 MB max upload
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

	raw, err := io.ReadAll(io.LimitReader(gz, 512<<20)) // 512 MB limit decompressed
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "failed to decompress backup")
		return
	}

	var env backupEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid backup JSON")
		return
	}

	if env.Version != backupVersion {
		httputil.RespondError(w, http.StatusBadRequest, fmt.Sprintf("unsupported backup version %q", env.Version))
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

	// Restore in a single transaction
	ctx := r.Context()
	tx, err := h.db.Begin(ctx)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Delete in FK-safe order
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

	// allowedColumns whitelists the exact column names accepted per table during
	// import. This prevents SQL injection via crafted column names even when the
	// HMAC verification passes (defense-in-depth).
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

	// allowedTables is the set of tables that may be targeted during import.
	allowedTables := map[string]bool{
		"system_settings": true, "users": true, "groups": true, "group_members": true,
		"tags": true, "files": true, "file_tags": true, "shares": true,
		"totp_credentials": true, "app_passwords": true,
	}

	// Insert helper using pgx INSERT with parameterised values
	insertRows := func(table string, rows []map[string]any) error {
		if !allowedTables[table] {
			return fmt.Errorf("unknown table %q", table)
		}
		allowed := allowedColumns[table]
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

	// Insert in FK-safe order
	restoreSteps := []struct {
		table string
		rows  []map[string]any
	}{
		{"system_settings", env.Data.SystemSettings},
		{"users", env.Data.Users},
		{"groups", env.Data.Groups},
		{"group_members", env.Data.GroupMembers},
		{"tags", env.Data.Tags},
		{"files", env.Data.Files},
		{"file_tags", env.Data.FileTags},
		{"shares", env.Data.Shares},
		{"totp_credentials", env.Data.TOTPCreds},
		{"app_passwords", env.Data.AppPasswords},
	}

	for _, step := range restoreSteps {
		if err := insertRows(step.table, step.rows); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, fmt.Sprintf("restore failed: %v", err))
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to commit restore")
		return
	}

	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
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
