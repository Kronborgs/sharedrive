package admin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	mail "github.com/wneessen/go-mail"

	"github.com/yourname/privatedrive/internal/config"
	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"

	"github.com/yourname/privatedrive/internal/files"
)

// Handler provides all admin HTTP handlers (settings, blocked IPs, audit logs,
// groups, tags, backup stubs).
type Handler struct {
	db        *pgxpool.Pool
	cfg       *config.Config
	ioTracker *files.IOTracker
}

func NewHandler(db *pgxpool.Pool, cfg *config.Config, ioTracker *files.IOTracker) *Handler {
	return &Handler{db: db, cfg: cfg, ioTracker: ioTracker}
}

// ─── System Settings ─────────────────────────────────────────────────────────

type settingsResponse struct {
	SiteName           string `json:"site_name"`
	AllowRegistrations bool   `json:"allow_registrations"`
	RequireInvite      bool   `json:"require_invite"`
	DefaultQuotaBytes  int64  `json:"default_quota_bytes"`
	MaxUploadBytes     int64  `json:"max_upload_bytes"`
	DirectUploadURL    string `json:"direct_upload_url"`
	SMTPHost           string `json:"smtp_host"`
	SMTPPort           int    `json:"smtp_port"`
	SMTPUsername       string `json:"smtp_username"`
	SMTPFromAddress    string `json:"smtp_from_address"`
	SMTPTls            bool   `json:"smtp_tls"`
}

func (h *Handler) GetSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := h.db.Query(ctx, `SELECT key, value FROM system_settings`)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	kv := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			continue
		}
		kv[k] = v
	}

	defaultQuota := int64(10 * 1 << 30) // 10 GB default
	if s, ok := kv["default_quota_bytes"]; ok {
		defaultQuota, _ = strconv.ParseInt(s, 10, 64)
	}
	maxUpload := int64(5 * 1 << 30) // 5 GB default
	if s, ok := kv["max_upload_bytes"]; ok {
		maxUpload, _ = strconv.ParseInt(s, 10, 64)
	}
	smtpPort := 587
	if s, ok := kv["smtp_port"]; ok {
		smtpPort, _ = strconv.Atoi(s)
	}

	httputil.Respond(w, http.StatusOK, settingsResponse{
		SiteName:           kv["app_name"],
		AllowRegistrations: kv["allow_registrations"] == "true",
		RequireInvite:      kv["require_invite"] == "true",
		DefaultQuotaBytes:  defaultQuota,
		MaxUploadBytes:     maxUpload,
		DirectUploadURL:    kv["direct_upload_url"],
		SMTPHost:           kv["smtp_host"],
		SMTPPort:           smtpPort,
		SMTPUsername:       kv["smtp_user"],
		SMTPFromAddress:    kv["smtp_from"],
		SMTPTls:            kv["smtp_tls"] == "starttls",
	})
}

// GetPublicSettings returns non-sensitive settings that are safe to expose to
// all authenticated and unauthenticated users (e.g. direct_upload_url).
// GET /api/v1/system/settings
func (h *Handler) GetPublicSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var directUploadURL string
	_ = h.db.QueryRow(ctx,
		`SELECT value FROM system_settings WHERE key = 'direct_upload_url'`,
	).Scan(&directUploadURL)
	httputil.Respond(w, http.StatusOK, map[string]string{
		"direct_upload_url": directUploadURL,
	})
}

type updateSettingsRequest struct {
	SiteName           *string `json:"site_name"`
	AllowRegistrations *bool   `json:"allow_registrations"`
	RequireInvite      *bool   `json:"require_invite"`
	DefaultQuotaBytes  *int64  `json:"default_quota_bytes"`
	MaxUploadBytes     *int64  `json:"max_upload_bytes"`
	DirectUploadURL    *string `json:"direct_upload_url"`
	SMTPHost           *string `json:"smtp_host"`
	SMTPPort           *int    `json:"smtp_port"`
	SMTPUsername       *string `json:"smtp_username"`
	SMTPPassword       *string `json:"smtp_password"`
	SMTPFromAddress    *string `json:"smtp_from_address"`
	SMTPTls            *bool   `json:"smtp_tls"`
}

func (h *Handler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req updateSettingsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}

	upsert := func(k, v string) {
		_, err := h.db.Exec(ctx,
			`INSERT INTO system_settings (key, value) VALUES ($1, $2)
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
			k, v,
		)
		if err != nil {
			log.Error().Err(err).Str("key", k).Msg("system_settings upsert failed")
		}
	}

	if req.SiteName != nil {
		upsert("app_name", *req.SiteName)
	}
	if req.AllowRegistrations != nil {
		if *req.AllowRegistrations {
			upsert("allow_registrations", "true")
		} else {
			upsert("allow_registrations", "false")
		}
	}
	if req.RequireInvite != nil {
		if *req.RequireInvite {
			upsert("require_invite", "true")
		} else {
			upsert("require_invite", "false")
		}
	}
	if req.DefaultQuotaBytes != nil {
		upsert("default_quota_bytes", strconv.FormatInt(*req.DefaultQuotaBytes, 10))
	}
	if req.MaxUploadBytes != nil {
		upsert("max_upload_bytes", strconv.FormatInt(*req.MaxUploadBytes, 10))
	}
	if req.DirectUploadURL != nil {
		upsert("direct_upload_url", *req.DirectUploadURL)
	}
	if req.SMTPHost != nil {
		upsert("smtp_host", *req.SMTPHost)
	}
	if req.SMTPPort != nil {
		upsert("smtp_port", strconv.Itoa(*req.SMTPPort))
	}
	if req.SMTPUsername != nil {
		upsert("smtp_user", *req.SMTPUsername)
	}
	if req.SMTPPassword != nil {
		upsert("smtp_password", *req.SMTPPassword)
	}
	if req.SMTPFromAddress != nil {
		upsert("smtp_from", *req.SMTPFromAddress)
	}
	if req.SMTPTls != nil {
		if *req.SMTPTls {
			upsert("smtp_tls", "starttls")
		} else {
			upsert("smtp_tls", "none")
		}
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

type smtpTestRequest struct {
	To string `json:"to"`
}

func (h *Handler) SMTPTest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var req smtpTestRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.To == "" {
		// Fall back to the logged-in admin's email address
		req.To = middleware.UserFromContext(ctx).Email
	}

	// Read SMTP settings from DB
	rows, err := h.db.Query(ctx, `SELECT key, value FROM system_settings WHERE key LIKE 'smtp_%'`)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()
	kv := map[string]string{}
	for rows.Next() {
		var k, v string
		_ = rows.Scan(&k, &v)
		kv[k] = v
	}

	host := kv["smtp_host"]
	if host == "" {
		httputil.RespondError(w, http.StatusBadRequest, "SMTP not configured")
		return
	}
	if kv["smtp_password"] == "" {
		httputil.RespondError(w, http.StatusBadRequest, "SMTP password not set — enter a password and save first")
		return
	}
	port := 587
	if s, ok := kv["smtp_port"]; ok {
		port, _ = strconv.Atoi(s)
	}

	m := mail.NewMsg()
	_ = m.From(kv["smtp_from"])
	_ = m.To(req.To)
	m.Subject("Sharedrive SMTP Test")
	m.SetBodyString(mail.TypeTextPlain, "This is a test email from your Sharedrive instance.")

	opts := []mail.Option{
		mail.WithPort(port),
		mail.WithTimeout(15 * time.Second),
		mail.WithUsername(kv["smtp_user"]),
		mail.WithPassword(kv["smtp_password"]),
		mail.WithSMTPAuth(mail.SMTPAuthPlain),
	}
	switch kv["smtp_tls"] {
	case "tls":
		opts = append(opts, mail.WithSSL())
	case "starttls":
		opts = append(opts, mail.WithTLSPolicy(mail.TLSMandatory))
	default:
		opts = append(opts, mail.WithTLSPolicy(mail.NoTLS))
	}
	c, err := mail.NewClient(host, opts...)
	if err != nil {
		log.Warn().Err(err).Str("host", host).Msg("admin: SMTP client init failed")
		httputil.RespondError(w, http.StatusInternalServerError, "failed to initialise SMTP client")
		return
	}
	if err := c.DialAndSend(m); err != nil {
		log.Warn().Err(err).Str("host", host).Msg("admin: SMTP test failed")
		// Use 422 instead of 502 — Cloudflare replaces 5xx response bodies with its
		// own HTML error page, which breaks JSON parsing on the frontend.
		httputil.RespondError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// ─── Blocked IPs ─────────────────────────────────────────────────────────────

type blockedIPEntry struct {
	IP        string    `json:"ip"`
	LockedAt  time.Time `json:"locked_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

// ListBlockedIPs lists IPs currently in the Redis lockout set.
// Since lockout data is in Redis (ephemeral), we return from Redis via a scan.
// For simplicity we return a placeholder — full implementation needs Redis scan.
func (h *Handler) ListBlockedIPs(w http.ResponseWriter, r *http.Request) {
	// The lockout data is stored in Redis as "lockout:ip:{ip}" keys.
	// A full implementation would inject the Redis client and do a SCAN.
	// Return empty list for now — the frontend handles empty state gracefully.
	httputil.Respond(w, http.StatusOK, []blockedIPEntry{})
}

func (h *Handler) UnblockIP(w http.ResponseWriter, r *http.Request) {
	// ip := chi.URLParam(r, "ip")
	// A full implementation would DELETE the Redis key and clear the lockout.
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// ─── IP Whitelist ─────────────────────────────────────────────────────────────

type whitelistEntry struct {
	ID          string    `json:"id"`
	IPCIDR      string    `json:"ip_cidr"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
}

func (h *Handler) ListWhitelist(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := h.db.Query(ctx,
		`SELECT id, ip_cidr, description, created_at FROM ip_whitelist ORDER BY created_at DESC`)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()
	var out []whitelistEntry
	for rows.Next() {
		var e whitelistEntry
		if err := rows.Scan(&e.ID, &e.IPCIDR, &e.Description, &e.CreatedAt); err != nil {
			continue
		}
		out = append(out, e)
	}
	if out == nil {
		out = []whitelistEntry{}
	}
	httputil.Respond(w, http.StatusOK, out)
}

type addWhitelistRequest struct {
	IPCIDR      string `json:"ip_cidr"`
	Description string `json:"description"`
}

func (h *Handler) AddWhitelist(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req addWhitelistRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.IPCIDR == "" {
		httputil.RespondError(w, http.StatusBadRequest, "ip_cidr is required")
		return
	}
	var id string
	err := h.db.QueryRow(ctx,
		`INSERT INTO ip_whitelist (ip_cidr, description, created_by) VALUES ($1, $2, $3) RETURNING id`,
		req.IPCIDR, req.Description, u.ID,
	).Scan(&id)
	if err != nil {
		httputil.RespondError(w, http.StatusConflict, "IP already in whitelist")
		return
	}
	httputil.Respond(w, http.StatusCreated, map[string]string{"id": id})
}

func (h *Handler) RemoveWhitelist(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	tag, err := h.db.Exec(ctx, `DELETE FROM ip_whitelist WHERE id = $1`, id)
	if err != nil || tag.RowsAffected() == 0 {
		httputil.RespondError(w, http.StatusNotFound, "entry not found")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// ─── Audit Logs ───────────────────────────────────────────────────────────────

type auditLogEntry struct {
	ID            string                 `json:"id"`
	EventType     string                 `json:"event_type"`
	ActorID       *string                `json:"actor_id,omitempty"`
	ActorEmail    *string                `json:"actor_email,omitempty"`
	TargetUserID  *string                `json:"target_user_id,omitempty"`
	ResourceType  *string                `json:"resource_type,omitempty"`
	ResourceID    *string                `json:"resource_id,omitempty"`
	ResourceName  *string                `json:"resource_name,omitempty"`
	Metadata      map[string]interface{} `json:"metadata,omitempty"`
	IPAddress     string                 `json:"ip_address,omitempty"`
	UserAgent     string                 `json:"user_agent,omitempty"`
	IsAdminAction bool                   `json:"is_admin_action"`
	CreatedAt     time.Time              `json:"created_at"`
}

func (h *Handler) AuditLogs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	q := r.URL.Query()
	limit := 100
	offset := 0
	if s := q.Get("limit"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	if s := q.Get("offset"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n >= 0 {
			offset = n
		}
	}
	eventType := q.Get("event_type")
	actorEmail := q.Get("actor_email")

	// Build dynamic WHERE clause with parameterized filters.
	var whereParts []string
	var filterArgs []any
	if eventType != "" {
		filterArgs = append(filterArgs, eventType)
		whereParts = append(whereParts, fmt.Sprintf("event_type = $%d", len(filterArgs)))
	}
	if actorEmail != "" {
		filterArgs = append(filterArgs, "%"+actorEmail+"%")
		whereParts = append(whereParts, fmt.Sprintf("actor_email ILIKE $%d", len(filterArgs)))
	}
	whereClause := ""
	if len(whereParts) > 0 {
		whereClause = "WHERE " + strings.Join(whereParts, " AND ")
	}

	var total int
	_ = h.db.QueryRow(ctx, `SELECT count(*) FROM audit_logs `+whereClause, filterArgs...).Scan(&total)

	paginatedArgs := append(filterArgs, limit, offset)
	limitIdx := len(paginatedArgs) - 1
	offsetIdx := len(paginatedArgs)
	rows, err := h.db.Query(ctx,
		fmt.Sprintf(
			`SELECT id, event_type, actor_id::TEXT, actor_email,
			        target_user_id::TEXT, resource_type, resource_id::TEXT, resource_name,
			        metadata, ip_address, user_agent, is_admin_action, created_at
			 FROM audit_logs
			 %s
			 ORDER BY created_at DESC
			 LIMIT $%d OFFSET $%d`,
			whereClause, limitIdx, offsetIdx,
		),
		paginatedArgs...,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	var out []auditLogEntry
	for rows.Next() {
		var e auditLogEntry
		var metaBytes []byte
		if err := rows.Scan(
			&e.ID, &e.EventType, &e.ActorID, &e.ActorEmail,
			&e.TargetUserID, &e.ResourceType, &e.ResourceID, &e.ResourceName,
			&metaBytes, &e.IPAddress, &e.UserAgent, &e.IsAdminAction, &e.CreatedAt,
		); err != nil {
			continue
		}
		if metaBytes != nil {
			_ = json.Unmarshal(metaBytes, &e.Metadata)
		}
		out = append(out, e)
	}
	if out == nil {
		out = []auditLogEntry{}
	}
	httputil.Respond(w, http.StatusOK, map[string]any{
		"items": out,
		"total": total,
	})
}

// UserActivity handles GET /api/v1/me/activity – returns the last 50 file events
// for the currently authenticated user.
func (h *Handler) UserActivity(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := middleware.UserFromContext(ctx)

	fileEvents := []string{
		"FILE_UPLOADED", "FILE_DOWNLOADED", "FILE_PREVIEWED",
		"ZIP_DOWNLOADED", "FILE_DELETED", "FILE_RESTORED",
		"FILE_MOVED", "FILE_RENAMED", "FOLDER_CREATED",
	}

	rows, err := h.db.Query(ctx,
		`SELECT id::TEXT, event_type, resource_name, ip_address, created_at
		 FROM audit_logs
		 WHERE actor_id = $1 AND event_type = ANY($2)
		 ORDER BY created_at DESC
		 LIMIT 50`,
		actor.ID, fileEvents,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	type activityEvent struct {
		ID           string    `json:"id"`
		EventType    string    `json:"event_type"`
		ResourceName *string   `json:"resource_name"`
		IPAddress    string    `json:"ip_address"`
		CreatedAt    time.Time `json:"created_at"`
	}
	var out []activityEvent
	for rows.Next() {
		var e activityEvent
		if err := rows.Scan(&e.ID, &e.EventType, &e.ResourceName, &e.IPAddress, &e.CreatedAt); err != nil {
			continue
		}
		out = append(out, e)
	}
	if out == nil {
		out = []activityEvent{}
	}
	httputil.Respond(w, http.StatusOK, out)
}

// ─── Dashboard Stats ─────────────────────────────────────────────────────────

// Stats handles GET /api/v1/admin/stats — returns aggregated dashboard metrics.
func (h *Handler) Stats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var totalUsers, activeUsers int
	var totalStorageUsed int64
	_ = h.db.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE is_active) FROM users`).
		Scan(&totalUsers, &activeUsers)
	_ = h.db.QueryRow(ctx, `SELECT coalesce(sum(quota_used_bytes),0) FROM users`).
		Scan(&totalStorageUsed)

	diskTotal, diskFree := diskStats(h.cfg.FilesRoot)

	// Activity counts from audit_logs (last 30 days)
	var logins, failedLogins, uploads, downloads, lockouts int
	cutoff := time.Now().UTC().Add(-30 * 24 * time.Hour)
	_ = h.db.QueryRow(ctx,
		`SELECT
		  count(*) FILTER (WHERE event_type = 'LOGIN_SUCCESS'),
		  count(*) FILTER (WHERE event_type = 'LOGIN_FAILED'),
		  count(*) FILTER (WHERE event_type = 'FILE_UPLOADED'),
		  count(*) FILTER (WHERE event_type = 'FILE_DOWNLOADED'),
		  count(*) FILTER (WHERE event_type LIKE 'LOCKOUT_%')
		 FROM audit_logs WHERE created_at > $1`, cutoff,
	).Scan(&logins, &failedLogins, &uploads, &downloads, &lockouts)

	httputil.Respond(w, http.StatusOK, map[string]any{
		"total_users":        totalUsers,
		"active_users":       activeUsers,
		"storage_used_bytes": totalStorageUsed,
		"disk_total_bytes":   diskTotal,
		"disk_free_bytes":    diskFree,
		"last_30_days": map[string]int{
			"logins":        logins,
			"failed_logins": failedLogins,
			"uploads":       uploads,
			"downloads":     downloads,
			"lockouts":      lockouts,
		},
	})
}

// ─── Groups ──────────────────────────────────────────────────────────────────

type group struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Color       string    `json:"color"`
	CreatedAt   time.Time `json:"created_at"`
}

type groupMember struct {
	UserID      string    `json:"user_id"`
	Email       string    `json:"email"`
	DisplayName string    `json:"display_name"`
	AddedAt     time.Time `json:"added_at"`
}

func (h *Handler) ListGroups(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := h.db.Query(ctx,
		`SELECT id, name, description, color, created_at FROM groups ORDER BY name ASC`)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()
	var out []group
	for rows.Next() {
		var g group
		if err := rows.Scan(&g.ID, &g.Name, &g.Description, &g.Color, &g.CreatedAt); err != nil {
			continue
		}
		out = append(out, g)
	}
	if out == nil {
		out = []group{}
	}
	httputil.Respond(w, http.StatusOK, out)
}

type createGroupRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Color       string `json:"color"`
}

func (h *Handler) CreateGroup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req createGroupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		httputil.RespondError(w, http.StatusBadRequest, "name is required")
		return
	}
	if req.Color == "" {
		req.Color = "#6b7280"
	}
	var id string
	err := h.db.QueryRow(ctx,
		`INSERT INTO groups (name, description, color, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
		req.Name, req.Description, req.Color, u.ID,
	).Scan(&id)
	if err != nil {
		httputil.RespondError(w, http.StatusConflict, "group name already exists")
		return
	}
	httputil.Respond(w, http.StatusCreated, map[string]string{"id": id})
}

type updateGroupRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	Color       *string `json:"color"`
}

func (h *Handler) UpdateGroup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	var req updateGroupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.Name != nil {
		if _, err := h.db.Exec(ctx, `UPDATE groups SET name = $1 WHERE id = $2`, *req.Name, id); err != nil {
			httputil.RespondError(w, http.StatusConflict, "group name already exists")
			return
		}
	}
	if req.Description != nil {
		if _, err := h.db.Exec(ctx, `UPDATE groups SET description = $1 WHERE id = $2`, *req.Description, id); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}
	}
	if req.Color != nil {
		if _, err := h.db.Exec(ctx, `UPDATE groups SET color = $1 WHERE id = $2`, *req.Color, id); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) DeleteGroup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	tag, err := h.db.Exec(ctx, `DELETE FROM groups WHERE id = $1`, id)
	if err != nil || tag.RowsAffected() == 0 {
		httputil.RespondError(w, http.StatusNotFound, "group not found")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) ListGroupMembers(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	groupID := chi.URLParam(r, "id")
	rows, err := h.db.Query(ctx,
		`SELECT gm.user_id, u.email, u.display_name, gm.added_at
		 FROM group_members gm
		 JOIN users u ON u.id = gm.user_id
		 WHERE gm.group_id = $1
		 ORDER BY gm.added_at DESC`,
		groupID,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()
	var out []groupMember
	for rows.Next() {
		var m groupMember
		if err := rows.Scan(&m.UserID, &m.Email, &m.DisplayName, &m.AddedAt); err != nil {
			continue
		}
		out = append(out, m)
	}
	if out == nil {
		out = []groupMember{}
	}
	httputil.Respond(w, http.StatusOK, out)
}

type groupMemberRequest struct {
	UserID string `json:"user_id"`
}

func (h *Handler) AddGroupMember(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	groupID := chi.URLParam(r, "id")
	var req groupMemberRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.UserID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "user_id is required")
		return
	}
	_, err := h.db.Exec(ctx,
		`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		groupID, req.UserID,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) RemoveGroupMember(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	groupID := chi.URLParam(r, "id")
	userID := chi.URLParam(r, "userId")
	h.db.Exec(ctx, `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, groupID, userID)
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// ─── Tags ────────────────────────────────────────────────────────────────────

type tag struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Color     string    `json:"color"`
	CreatedAt time.Time `json:"created_at"`
}

func (h *Handler) ListTags(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := h.db.Query(ctx, `SELECT id, name, color, created_at FROM tags ORDER BY name ASC`)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()
	var out []tag
	for rows.Next() {
		var t tag
		if err := rows.Scan(&t.ID, &t.Name, &t.Color, &t.CreatedAt); err != nil {
			continue
		}
		out = append(out, t)
	}
	if out == nil {
		out = []tag{}
	}
	httputil.Respond(w, http.StatusOK, out)
}

type createTagRequest struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

func (h *Handler) CreateTag(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req createTagRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		httputil.RespondError(w, http.StatusBadRequest, "name is required")
		return
	}
	if req.Color == "" {
		req.Color = "#6b7280"
	}
	var id string
	err := h.db.QueryRow(ctx,
		`INSERT INTO tags (name, color, created_by) VALUES ($1, $2, $3) RETURNING id`,
		req.Name, req.Color, u.ID,
	).Scan(&id)
	if err != nil {
		httputil.RespondError(w, http.StatusConflict, "tag name already exists")
		return
	}
	httputil.Respond(w, http.StatusCreated, map[string]string{"id": id})
}

type updateTagRequest struct {
	Name  *string `json:"name"`
	Color *string `json:"color"`
}

func (h *Handler) UpdateTag(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	var req updateTagRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.Name != nil {
		h.db.Exec(ctx, `UPDATE tags SET name = $1 WHERE id = $2`, *req.Name, id)
	}
	if req.Color != nil {
		h.db.Exec(ctx, `UPDATE tags SET color = $1 WHERE id = $2`, *req.Color, id)
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) DeleteTag(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	tag, err := h.db.Exec(ctx, `DELETE FROM tags WHERE id = $1`, id)
	if err != nil || tag.RowsAffected() == 0 {
		httputil.RespondError(w, http.StatusNotFound, "tag not found")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// ─── Storage Scrub ────────────────────────────────────────────────────────────

// ScrubResult holds the stats returned from a storage scrub.
type ScrubResult struct {
	ScannedBlobs int64 `json:"scanned_blobs"`
	DeletedBlobs int64 `json:"deleted_blobs"`
	FreedBytes   int64 `json:"freed_bytes"`
}

// StorageScrub walks the files root, finds blobs with no matching DB record,
// and deletes them. Safe to call at any time; only touches files in the
// two-level UUID-shard layout ({root}/{2-char-prefix}/{uuid}).
func (h *Handler) StorageScrub(w http.ResponseWriter, r *http.Request) {
	result, err := RunStorageScrub(r.Context(), h.db, h.cfg.FilesRoot)
	if err != nil {
		log.Error().Err(err).Msg("storage scrub failed")
		httputil.RespondError(w, http.StatusInternalServerError, "scrub failed")
		return
	}
	httputil.Respond(w, http.StatusOK, result)
}

// RunStorageScrub is the core scrub logic — exported so it can also be called
// from the server startup goroutine.
func RunStorageScrub(ctx context.Context, db *pgxpool.Pool, filesRoot string) (*ScrubResult, error) {
	// Collect all UUIDs found on disk (only files exactly 2 levels deep).
	type blob struct {
		id   string
		path string
		size int64
	}
	var blobs []blob

	entries, err := os.ReadDir(filesRoot)
	if err != nil {
		return nil, fmt.Errorf("storage scrub: read root: %w", err)
	}
	for _, shard := range entries {
		if !shard.IsDir() || len(shard.Name()) != 2 {
			continue
		}
		shardPath := filepath.Join(filesRoot, shard.Name())
		files, err := os.ReadDir(shardPath)
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() {
				continue
			}
			name := f.Name()
			// Must look like a UUID (36 chars with dashes)
			if len(name) != 36 {
				continue
			}
			info, err := f.Info()
			if err != nil {
				continue
			}
			blobs = append(blobs, blob{
				id:   name,
				path: filepath.Join(shardPath, name),
				size: info.Size(),
			})
		}
	}

	result := &ScrubResult{ScannedBlobs: int64(len(blobs))}

	// Process in batches of 500 to avoid huge IN() clauses.
	const batchSize = 500
	for i := 0; i < len(blobs); i += batchSize {
		end := i + batchSize
		if end > len(blobs) {
			end = len(blobs)
		}
		batch := blobs[i:end]

		// Build a set of IDs to check.
		ids := make([]string, len(batch))
		for j, b := range batch {
			ids[j] = b.id
		}

		// Query which IDs actually exist in the files table.
		rows, err := db.Query(ctx, `SELECT id::text FROM files WHERE id = ANY($1::uuid[])`, ids)
		if err != nil {
			return nil, fmt.Errorf("storage scrub: db query: %w", err)
		}
		known := make(map[string]struct{})
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err == nil {
				known[id] = struct{}{}
			}
		}
		rows.Close()

		// Delete blobs not in DB.
		for _, b := range batch {
			if _, exists := known[b.id]; exists {
				continue
			}
			if err := os.Remove(b.path); err != nil && !os.IsNotExist(err) {
				log.Warn().Str("path", b.path).Err(err).Msg("storage scrub: failed to delete orphan")
				continue
			}
			result.DeletedBlobs++
			result.FreedBytes += b.size
			log.Debug().Str("id", b.id).Int64("bytes", b.size).Msg("storage scrub: deleted orphan blob")
		}
	}

	log.Info().
		Int64("scanned", result.ScannedBlobs).
		Int64("deleted", result.DeletedBlobs).
		Int64("freed_bytes", result.FreedBytes).
		Msg("storage scrub completed")

	return result, nil
}

// ─── I/O Stats ───────────────────────────────────────────────────────────────

// IOStatsResponse is the response for GET /api/v1/admin/io-stats.
type IOStatsResponse struct {
	Users []IOUserStats `json:"users"`
}

// IOUserStats holds I/O stats for one user, enriched with DB display info.
type IOUserStats struct {
	UserID          string `json:"user_id"`
	Email           string `json:"email"`
	DisplayName     string `json:"display_name"`
	UploadBytes     int64  `json:"upload_bytes"`
	DownloadBytes   int64  `json:"download_bytes"`
	UploadBytesPS   int64  `json:"upload_bytes_per_sec"`
	DownloadBytesPS int64  `json:"download_bytes_per_sec"`
}

// IOStats handles GET /api/v1/admin/io-stats — returns near-real-time per-user
// upload/download rates for the last ~2 minutes.
func (h *Handler) IOStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	if h.ioTracker == nil {
		httputil.Respond(w, http.StatusOK, IOStatsResponse{Users: []IOUserStats{}})
		return
	}

	rawStats, err := h.ioTracker.CurrentStats(ctx)
	if err != nil || len(rawStats) == 0 {
		httputil.Respond(w, http.StatusOK, IOStatsResponse{Users: []IOUserStats{}})
		return
	}

	// Collect unique user IDs.
	ids := make([]string, len(rawStats))
	for i, s := range rawStats {
		ids[i] = s.UserID
	}

	// Batch-fetch email + display_name from DB.
	rows, err := h.db.Query(ctx,
		`SELECT id::text, email, display_name FROM users WHERE id = ANY($1::uuid[])`, ids)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	type userInfo struct{ email, displayName string }
	userMap := map[string]userInfo{}
	for rows.Next() {
		var id, email, name string
		if err := rows.Scan(&id, &email, &name); err == nil {
			userMap[id] = userInfo{email, name}
		}
	}

	out := make([]IOUserStats, 0, len(rawStats))
	for _, s := range rawStats {
		info := userMap[s.UserID]
		out = append(out, IOUserStats{
			UserID:          s.UserID,
			Email:           info.email,
			DisplayName:     info.displayName,
			UploadBytes:     s.UploadBytes,
			DownloadBytes:   s.DownloadBytes,
			UploadBytesPS:   s.UploadBytesPS,
			DownloadBytesPS: s.DownloadBytesPS,
		})
	}

	httputil.Respond(w, http.StatusOK, IOStatsResponse{Users: out})
}
