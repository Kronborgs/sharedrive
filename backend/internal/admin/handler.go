package admin

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	mail "github.com/wneessen/go-mail"

	"github.com/yourname/privatedrive/internal/config"
	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

// Handler provides all admin HTTP handlers (settings, blocked IPs, audit logs,
// groups, tags, backup stubs).
type Handler struct {
	db  *pgxpool.Pool
	cfg *config.Config
}

func NewHandler(db *pgxpool.Pool, cfg *config.Config) *Handler {
	return &Handler{db: db, cfg: cfg}
}

// ─── System Settings ─────────────────────────────────────────────────────────

type settingsResponse struct {
	SiteName           string `json:"site_name"`
	AllowRegistrations bool   `json:"allow_registrations"`
	RequireInvite      bool   `json:"require_invite"`
	DefaultQuotaBytes  int64  `json:"default_quota_bytes"`
	MaxUploadBytes     int64  `json:"max_upload_bytes"`
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
		SMTPHost:           kv["smtp_host"],
		SMTPPort:           smtpPort,
		SMTPUsername:       kv["smtp_user"],
		SMTPFromAddress:    kv["smtp_from"],
		SMTPTls:            kv["smtp_tls"] == "starttls",
	})
}

type updateSettingsRequest struct {
	SiteName           *string `json:"site_name"`
	AllowRegistrations *bool   `json:"allow_registrations"`
	RequireInvite      *bool   `json:"require_invite"`
	DefaultQuotaBytes  *int64  `json:"default_quota_bytes"`
	MaxUploadBytes     *int64  `json:"max_upload_bytes"`
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

	var total int
	_ = h.db.QueryRow(ctx, `SELECT count(*) FROM audit_logs`).Scan(&total)

	rows, err := h.db.Query(ctx,
		`SELECT id, event_type, actor_id::TEXT, actor_email,
		        target_user_id::TEXT, resource_type, resource_id::TEXT, resource_name,
		        metadata, ip_address, user_agent, is_admin_action, created_at
		 FROM audit_logs
		 ORDER BY created_at DESC
		 LIMIT $1 OFFSET $2`,
		limit, offset,
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
		`SELECT id, name, description, created_at FROM groups ORDER BY name ASC`)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()
	var out []group
	for rows.Next() {
		var g group
		if err := rows.Scan(&g.ID, &g.Name, &g.Description, &g.CreatedAt); err != nil {
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
	var id string
	err := h.db.QueryRow(ctx,
		`INSERT INTO groups (name, description, created_by) VALUES ($1, $2, $3) RETURNING id`,
		req.Name, req.Description, u.ID,
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


