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

const (
	backupVersion       = "2"
	legacyBackupVersion = "1"
)

const backupFileSuffix = ".json.gz"

type exportStep struct {
	name  string
	query string
	set   func(*backupData, []map[string]any)
}

var backupExportSteps = []exportStep{
	{name: "users", query: `SELECT id, email, display_name, password_hash, role, is_active, quota_bytes, quota_used_bytes, bandwidth_limit_bytes_per_day, webdav_enabled, rooms_access_enabled, rooms_only_account, chat_notifications_enabled, invited_by, last_login_at, created_at, updated_at FROM users`, set: func(d *backupData, v []map[string]any) { d.Users = v }},
	{name: "user_product_access", query: `SELECT user_id, product, access_level, created_at, updated_at FROM user_product_access`, set: func(d *backupData, v []map[string]any) { d.UserProductAccess = v }},
	{name: "groups", query: `SELECT id, name, description, created_by, created_at, is_system_managed FROM groups`, set: func(d *backupData, v []map[string]any) { d.Groups = v }},
	{name: "group_members", query: `SELECT group_id, user_id, added_at FROM group_members`, set: func(d *backupData, v []map[string]any) { d.GroupMembers = v }},
	{name: "tags", query: `SELECT id, name, color, created_by, created_at FROM tags`, set: func(d *backupData, v []map[string]any) { d.Tags = v }},
	{name: "files", query: `SELECT id, parent_id, owner_id, name, is_folder, mime_type, size_bytes, storage_path, checksum_sha256, deleted_at, created_at, updated_at FROM files`, set: func(d *backupData, v []map[string]any) { d.Files = v }},
	{name: "file_tags", query: `SELECT file_id, tag_id FROM file_tags`, set: func(d *backupData, v []map[string]any) { d.FileTags = v }},
	{name: "shares", query: `SELECT id, resource_id, owner_id, grantee_type, grantee_id, can_view, can_upload, can_edit, can_delete, can_reshare, created_by, expires_at, revoked_at, created_at FROM shares`, set: func(d *backupData, v []map[string]any) { d.Shares = v }},
	{name: "totp_credentials", query: `SELECT id, user_id, encrypted_secret, backup_codes, confirmed_at, created_at FROM totp_credentials`, set: func(d *backupData, v []map[string]any) { d.TOTPCreds = v }},
	{name: "app_passwords", query: `SELECT id, user_id, name, password_hash, scope, last_used_at, revoked_at, created_at FROM app_passwords`, set: func(d *backupData, v []map[string]any) { d.AppPasswords = v }},
	{name: "system_settings", query: `SELECT key, value, updated_at FROM system_settings`, set: func(d *backupData, v []map[string]any) { d.SystemSettings = v }},
	{name: "rooms", query: `SELECT id, name, slug, owner_id, managed_group_id, icon_file_id, created_by, created_at, updated_at, archived_at FROM rooms`, set: func(d *backupData, v []map[string]any) { d.Rooms = v }},
	{name: "room_members", query: `SELECT room_id, user_id, role, joined_at, added_by FROM room_members`, set: func(d *backupData, v []map[string]any) { d.RoomMembers = v }},
	{name: "room_invites", query: `SELECT id, room_id, token_hash, label, created_by, can_chat, can_upload, can_voice, can_share_screen, expires_at, revoked_at, created_at FROM room_invites`, set: func(d *backupData, v []map[string]any) { d.RoomInvites = v }},
	// Guest session secrets are intentionally never exported. The synthetic hash
	// only preserves foreign-key history for guest-authored messages on restore.
	{name: "room_guest_sessions", query: `SELECT id, invite_id, encode(digest(id::text || 'rooms-backup-revoked-session', 'sha256'), 'hex') AS session_token_hash, display_name, expires_at, revoked_at, last_accessed_at, created_at FROM room_guest_sessions`, set: func(d *backupData, v []map[string]any) { d.RoomGuestSessions = v }},
	{name: "room_messages", query: `SELECT id, room_id, sender_user_id, sender_guest_session_id, body, reply_to_message_id, created_at, edited_at, deleted_at FROM room_messages ORDER BY created_at, id`, set: func(d *backupData, v []map[string]any) { d.RoomMessages = v }},
	{name: "room_reactions", query: `SELECT message_id, user_id, guest_session_id, emoji, created_at FROM room_reactions`, set: func(d *backupData, v []map[string]any) { d.RoomReactions = v }},
	{name: "room_read_state", query: `SELECT room_id, user_id, last_read_message_id, updated_at FROM room_read_state`, set: func(d *backupData, v []map[string]any) { d.RoomReadState = v }},
	{name: "room_guest_read_state", query: `SELECT room_id, guest_session_id, last_read_message_id, updated_at FROM room_guest_read_state`, set: func(d *backupData, v []map[string]any) { d.RoomGuestReadState = v }},
	{name: "room_resources", query: `SELECT id, room_id, resource_type, resource_id, added_by, message_id, created_at FROM room_resources`, set: func(d *backupData, v []map[string]any) { d.RoomResources = v }},
	{name: "room_gif_library", query: `SELECT id, file_id, title, search_terms, category, created_by, created_at FROM room_gif_library`, set: func(d *backupData, v []map[string]any) { d.RoomGIFLibrary = v }},
	{name: "room_guest_uploads", query: `SELECT id, room_id, guest_session_id, file_id, created_at FROM room_guest_uploads`, set: func(d *backupData, v []map[string]any) { d.RoomGuestUploads = v }},
	{name: "direct_conversations", query: `SELECT id, source_room_id, user_one_id, user_two_id, created_at, updated_at FROM direct_conversations`, set: func(d *backupData, v []map[string]any) { d.DirectConversations = v }},
	{name: "direct_messages", query: `SELECT id, conversation_id, sender_user_id, body, reply_to_message_id, created_at, edited_at, deleted_at FROM direct_messages ORDER BY created_at, id`, set: func(d *backupData, v []map[string]any) { d.DirectMessages = v }},
	{name: "direct_reactions", query: `SELECT message_id, user_id, emoji, created_at FROM direct_reactions`, set: func(d *backupData, v []map[string]any) { d.DirectReactions = v }},
	{name: "direct_read_state", query: `SELECT conversation_id, user_id, last_read_message_id, updated_at FROM direct_read_state`, set: func(d *backupData, v []map[string]any) { d.DirectReadState = v }},
}

var backupRestoreStatements = []string{
	`DELETE FROM file_tags`,
	`DELETE FROM shares`,
	`DELETE FROM app_passwords`,
	`DELETE FROM totp_credentials`,
	`DELETE FROM group_members`,
	`DELETE FROM user_product_access`,
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

var roomBackupRestoreStatements = []string{
	`DELETE FROM room_gif_library`,
	`DELETE FROM direct_read_state`,
	`DELETE FROM direct_reactions`,
	`DELETE FROM direct_messages`,
	`DELETE FROM direct_conversations`,
	`DELETE FROM room_guest_uploads`,
	`DELETE FROM room_guest_read_state`,
	`DELETE FROM room_reactions`,
	`DELETE FROM room_read_state`,
	`DELETE FROM room_messages`,
	`DELETE FROM room_guest_sessions`,
	`DELETE FROM room_invites`,
	`DELETE FROM room_resources`,
	`DELETE FROM room_members`,
	`DELETE FROM room_member_invitations`,
	`DELETE FROM rooms`,
}

type backupEnvelope struct {
	Version   string     `json:"version"`
	CreatedAt time.Time  `json:"created_at"`
	HMAC      string     `json:"hmac"`
	Data      backupData `json:"data"`
}

type backupData struct {
	Users               []map[string]any `json:"users"`
	UserProductAccess   []map[string]any `json:"user_product_access,omitempty"`
	Groups              []map[string]any `json:"groups"`
	GroupMembers        []map[string]any `json:"group_members"`
	Tags                []map[string]any `json:"tags"`
	Files               []map[string]any `json:"files"`
	FileTags            []map[string]any `json:"file_tags"`
	Shares              []map[string]any `json:"shares"`
	TOTPCreds           []map[string]any `json:"totp_credentials"`
	AppPasswords        []map[string]any `json:"app_passwords"`
	SystemSettings      []map[string]any `json:"system_settings"`
	Rooms               []map[string]any `json:"rooms,omitempty"`
	RoomMembers         []map[string]any `json:"room_members,omitempty"`
	RoomInvites         []map[string]any `json:"room_invites,omitempty"`
	RoomGuestSessions   []map[string]any `json:"room_guest_sessions,omitempty"`
	RoomMessages        []map[string]any `json:"room_messages,omitempty"`
	RoomReactions       []map[string]any `json:"room_reactions,omitempty"`
	RoomReadState       []map[string]any `json:"room_read_state,omitempty"`
	RoomGuestReadState  []map[string]any `json:"room_guest_read_state,omitempty"`
	RoomResources       []map[string]any `json:"room_resources,omitempty"`
	RoomGIFLibrary      []map[string]any `json:"room_gif_library,omitempty"`
	RoomGuestUploads    []map[string]any `json:"room_guest_uploads,omitempty"`
	DirectConversations []map[string]any `json:"direct_conversations,omitempty"`
	DirectMessages      []map[string]any `json:"direct_messages,omitempty"`
	DirectReactions     []map[string]any `json:"direct_reactions,omitempty"`
	DirectReadState     []map[string]any `json:"direct_read_state,omitempty"`
	RoomsIncluded       bool             `json:"rooms_included"`
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
	includeRooms, err := h.roomsBackupEnabled(ctx)
	if err != nil {
		return backupData{}, err
	}
	data.RoomsIncluded = includeRooms
	for _, step := range backupExportSteps {
		if isRoomsBackupStep(step.name) && !includeRooms {
			continue
		}
		rows, err := h.queryRows(ctx, step.query)
		if err != nil {
			return backupData{}, fmt.Errorf("failed to export %s", step.name)
		}
		step.set(&data, rows)
	}

	return data, nil
}

func (h *Handler) roomsBackupEnabled(ctx context.Context) (bool, error) {
	var enabled bool
	err := h.db.QueryRow(ctx, `SELECT COALESCE((SELECT value = 'true' FROM system_settings WHERE key = 'rooms_backup_enabled'), TRUE)`).Scan(&enabled)
	if err != nil {
		return false, fmt.Errorf("failed to read Rooms backup setting")
	}
	return enabled, nil
}

func isRoomsBackupStep(name string) bool {
	return name == "rooms" || strings.HasPrefix(name, "room_") || strings.HasPrefix(name, "direct_")
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
	if env.Version != backupVersion && env.Version != legacyBackupVersion {
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
	includeRooms := env.Version == backupVersion && env.Data.RoomsIncluded
	if !includeRooms {
		var roomsExist bool
		if err := h.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM rooms)`).Scan(&roomsExist); err != nil {
			return fmt.Errorf("failed to check existing Rooms before restore")
		}
		if roomsExist {
			return fmt.Errorf("this backup does not include Rooms and cannot safely be restored while Rooms exist; export a current backup with Rooms first")
		}
	}
	tx, err := h.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin transaction")
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if err := clearBackupRestoreTables(ctx, tx, includeRooms); err != nil {
		return err
	}

	if includeRooms {
		revokeRestoredGuestAccess(&env.Data)
	}
	if err := insertEnvelopeRows(ctx, tx, env.Data, includeRooms); err != nil {
		return fmt.Errorf("restore failed: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit restore")
	}

	return nil
}

func clearBackupRestoreTables(ctx context.Context, tx pgx.Tx, includeRooms bool) error {
	if includeRooms {
		for _, stmt := range roomBackupRestoreStatements {
			if _, err := tx.Exec(ctx, stmt); err != nil {
				return fmt.Errorf("failed to clear Rooms table: %v", err)
			}
		}
	}
	for _, stmt := range backupRestoreStatements {
		if _, err := tx.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("failed to clear table: %v", err)
		}
	}
	return nil
}

func insertEnvelopeRows(ctx context.Context, tx pgx.Tx, data backupData, includeRooms bool) error {
	allowedColumns := map[string]map[string]bool{
		"system_settings": {"key": true, "value": true, "updated_at": true},
		"users": {
			"id": true, "email": true, "display_name": true, "password_hash": true,
			"role": true, "is_active": true, "quota_bytes": true, "quota_used_bytes": true,
			"bandwidth_limit_bytes_per_day": true, "webdav_enabled": true, "rooms_access_enabled": true,
			"rooms_only_account": true, "chat_notifications_enabled": true, "invited_by": true,
			"last_login_at": true, "created_at": true, "updated_at": true,
		},
		"user_product_access": {"user_id": true, "product": true, "access_level": true, "created_at": true, "updated_at": true},
		"groups":        {"id": true, "name": true, "description": true, "created_by": true, "created_at": true, "is_system_managed": true},
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
		"totp_credentials":      {"id": true, "user_id": true, "encrypted_secret": true, "backup_codes": true, "confirmed_at": true, "created_at": true},
		"app_passwords":         {"id": true, "user_id": true, "name": true, "password_hash": true, "scope": true, "last_used_at": true, "revoked_at": true, "created_at": true},
		"rooms":                 {"id": true, "name": true, "slug": true, "owner_id": true, "managed_group_id": true, "icon_file_id": true, "created_by": true, "created_at": true, "updated_at": true, "archived_at": true},
		"room_members":          {"room_id": true, "user_id": true, "role": true, "joined_at": true, "added_by": true},
		"room_invites":          {"id": true, "room_id": true, "token_hash": true, "label": true, "created_by": true, "can_chat": true, "can_upload": true, "can_voice": true, "can_share_screen": true, "expires_at": true, "revoked_at": true, "created_at": true},
		"room_guest_sessions":   {"id": true, "invite_id": true, "session_token_hash": true, "display_name": true, "expires_at": true, "revoked_at": true, "last_accessed_at": true, "created_at": true},
		"room_messages":         {"id": true, "room_id": true, "sender_user_id": true, "sender_guest_session_id": true, "body": true, "reply_to_message_id": true, "created_at": true, "edited_at": true, "deleted_at": true},
		"room_reactions":        {"message_id": true, "user_id": true, "guest_session_id": true, "emoji": true, "created_at": true},
		"room_read_state":       {"room_id": true, "user_id": true, "last_read_message_id": true, "updated_at": true},
		"room_guest_read_state": {"room_id": true, "guest_session_id": true, "last_read_message_id": true, "updated_at": true},
		"room_resources":        {"id": true, "room_id": true, "resource_type": true, "resource_id": true, "added_by": true, "message_id": true, "created_at": true},
		"room_gif_library":      {"id": true, "file_id": true, "title": true, "search_terms": true, "category": true, "created_by": true, "created_at": true},
		"room_guest_uploads":    {"id": true, "room_id": true, "guest_session_id": true, "file_id": true, "created_at": true},
		"direct_conversations":  {"id": true, "source_room_id": true, "user_one_id": true, "user_two_id": true, "created_at": true, "updated_at": true},
		"direct_messages":       {"id": true, "conversation_id": true, "sender_user_id": true, "body": true, "reply_to_message_id": true, "created_at": true, "edited_at": true, "deleted_at": true},
		"direct_reactions":      {"message_id": true, "user_id": true, "emoji": true, "created_at": true},
		"direct_read_state":     {"conversation_id": true, "user_id": true, "last_read_message_id": true, "updated_at": true},
	}

	type restoreStep struct {
		table string
		rows  []map[string]any
	}
	restoreSteps := []restoreStep{
		{"system_settings", data.SystemSettings},
		{"users", data.Users},
		restoreStep{"user_product_access", data.UserProductAccess},
		{"groups", data.Groups},
		{"group_members", data.GroupMembers},
		{"tags", data.Tags},
		{"files", data.Files},
		{"file_tags", data.FileTags},
		{"shares", data.Shares},
		{"totp_credentials", data.TOTPCreds},
		{"app_passwords", data.AppPasswords},
	}
	if includeRooms {
		restoreSteps = append(restoreSteps,
			restoreStep{"rooms", data.Rooms},
			restoreStep{"room_members", data.RoomMembers},
			restoreStep{"room_invites", data.RoomInvites},
			restoreStep{"room_guest_sessions", data.RoomGuestSessions},
			restoreStep{"room_messages", data.RoomMessages},
			restoreStep{"room_reactions", data.RoomReactions},
			restoreStep{"room_read_state", data.RoomReadState},
			restoreStep{"room_guest_read_state", data.RoomGuestReadState},
			restoreStep{"room_resources", data.RoomResources},
			restoreStep{"room_gif_library", data.RoomGIFLibrary},
			restoreStep{"room_guest_uploads", data.RoomGuestUploads},
			restoreStep{"direct_conversations", data.DirectConversations},
			restoreStep{"direct_messages", data.DirectMessages},
			restoreStep{"direct_reactions", data.DirectReactions},
			restoreStep{"direct_read_state", data.DirectReadState},
		)
	}

	for _, step := range restoreSteps {
		if err := insertRowsForTable(ctx, tx, step.table, step.rows, allowedColumns[step.table]); err != nil {
			return err
		}
	}

	return nil
}

// revokeRestoredGuestAccess preserves Rooms history while ensuring a backup
// restore can never reactivate a previously issued guest URL or browser session.
func revokeRestoredGuestAccess(data *backupData) {
	revokedAt := time.Now().UTC()
	for _, invite := range data.RoomInvites {
		invite["revoked_at"] = revokedAt
	}
	for _, session := range data.RoomGuestSessions {
		session["revoked_at"] = revokedAt
	}
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
