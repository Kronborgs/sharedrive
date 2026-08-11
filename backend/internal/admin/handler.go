package admin

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
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
	rdb       *redis.Client
}

func NewHandler(db *pgxpool.Pool, cfg *config.Config, ioTracker *files.IOTracker, rdb *redis.Client) *Handler {
	return &Handler{db: db, cfg: cfg, ioTracker: ioTracker, rdb: rdb}
}

// ─── System Settings ─────────────────────────────────────────────────────────

type settingsResponse struct {
	SiteName               string `json:"site_name"`
	AllowRegistrations     bool   `json:"allow_registrations"`
	RequireInvite          bool   `json:"require_invite"`
	DefaultQuotaBytes      int64  `json:"default_quota_bytes"`
	MaxUploadBytes         int64  `json:"max_upload_bytes"`
	DirectUploadURL        string `json:"direct_upload_url"`
	SMTPHost               string `json:"smtp_host"`
	SMTPPort               int    `json:"smtp_port"`
	SMTPUsername           string `json:"smtp_username"`
	SMTPFromAddress        string `json:"smtp_from_address"`
	SMTPTls                bool   `json:"smtp_tls"`
	OnlyOfficeURL          string `json:"onlyoffice_url"`
	OnlyOfficeJWTSecret    string `json:"onlyoffice_jwt_secret"`     // always empty in response — write-only
	OnlyOfficeJWTSecretSet bool   `json:"onlyoffice_jwt_secret_set"` // true when a secret is stored
	PlaylistMaxTracks      int    `json:"playlist_max_tracks"`
}

func (h *Handler) GetSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := h.db.Query(ctx, `SELECT key, value FROM system_settings`)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, errInternal)
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
	playlistMaxTracks := 200
	if s, ok := kv["playlist_max_tracks"]; ok {
		if n, err2 := strconv.Atoi(s); err2 == nil && n > 0 {
			playlistMaxTracks = n
		}
	}

	httputil.Respond(w, http.StatusOK, settingsResponse{
		SiteName:               kv["app_name"],
		AllowRegistrations:     kv["allow_registrations"] == "true",
		RequireInvite:          kv["require_invite"] == "true",
		DefaultQuotaBytes:      defaultQuota,
		MaxUploadBytes:         maxUpload,
		DirectUploadURL:        kv["direct_upload_url"],
		SMTPHost:               kv["smtp_host"],
		SMTPPort:               smtpPort,
		SMTPUsername:           kv["smtp_user"],
		SMTPFromAddress:        kv["smtp_from"],
		SMTPTls:                kv["smtp_tls"] == "starttls",
		OnlyOfficeURL:          kv["onlyoffice_url"],
		OnlyOfficeJWTSecret:    "", // never expose via API
		OnlyOfficeJWTSecretSet: kv["onlyoffice_jwt_secret"] != "",
		PlaylistMaxTracks:      playlistMaxTracks,
	})
}

// GetPublicSettings returns non-sensitive settings that are safe to expose to
// all authenticated and unauthenticated users (e.g. direct_upload_url).
// GET /api/v1/system/settings
func (h *Handler) GetPublicSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := h.db.Query(ctx,
		`SELECT key, value FROM system_settings WHERE key IN ('direct_upload_url','onlyoffice_url','playlist_max_tracks')`)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, errInternal)
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
	playlistMax := 200
	if s := kv["playlist_max_tracks"]; s != "" {
		if n, err2 := strconv.Atoi(s); err2 == nil && n > 0 {
			playlistMax = n
		}
	}
	directUploadURL := strings.TrimSpace(kv["direct_upload_url"])
	directUploadsEnabled := directUploadURL != ""
	uploadEndpoint := ""
	if directUploadsEnabled {
		uploadEndpoint = strings.TrimRight(directUploadURL, "/") + "/upload/"
	}
	httputil.Respond(w, http.StatusOK, map[string]any{
		"direct_upload_url":      directUploadURL,
		"direct_uploads_enabled": directUploadsEnabled,
		"upload_endpoint":        uploadEndpoint,
		"onlyoffice_url":         kv["onlyoffice_url"],
		"playlist_max_tracks":    playlistMax,
	})
}

type updateSettingsRequest struct {
	SiteName            *string `json:"site_name"`
	AllowRegistrations  *bool   `json:"allow_registrations"`
	RequireInvite       *bool   `json:"require_invite"`
	DefaultQuotaBytes   *int64  `json:"default_quota_bytes"`
	MaxUploadBytes      *int64  `json:"max_upload_bytes"`
	DirectUploadURL     *string `json:"direct_upload_url"`
	SMTPHost            *string `json:"smtp_host"`
	SMTPPort            *int    `json:"smtp_port"`
	SMTPUsername        *string `json:"smtp_username"`
	SMTPPassword        *string `json:"smtp_password"`
	SMTPFromAddress     *string `json:"smtp_from_address"`
	SMTPTls             *bool   `json:"smtp_tls"`
	OnlyOfficeURL       *string `json:"onlyoffice_url"`
	OnlyOfficeJWTSecret *string `json:"onlyoffice_jwt_secret"`
	PlaylistMaxTracks   *int    `json:"playlist_max_tracks"`
}

type settingsUpserter struct {
	ctx context.Context
	db  *pgxpool.Pool
}

func newSettingsUpserter(ctx context.Context, db *pgxpool.Pool) *settingsUpserter {
	return &settingsUpserter{ctx: ctx, db: db}
}

func (u *settingsUpserter) upsert(key, value string) {
	_, err := u.db.Exec(u.ctx,
		`INSERT INTO system_settings (key, value) VALUES ($1, $2)
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
		key, value,
	)
	if err != nil {
		log.Error().Err(err).Str("key", key).Msg("system_settings upsert failed")
	}
}

func (u *settingsUpserter) setString(key string, value *string) {
	if value != nil {
		u.upsert(key, *value)
	}
}

func (u *settingsUpserter) setInt64(key string, value *int64) {
	if value != nil {
		u.upsert(key, strconv.FormatInt(*value, 10))
	}
}

func (u *settingsUpserter) setInt(key string, value *int) {
	if value != nil {
		u.upsert(key, strconv.Itoa(*value))
	}
}

func (u *settingsUpserter) setBool(key string, value *bool) {
	if value != nil {
		u.upsert(key, strconv.FormatBool(*value))
	}
}

func (u *settingsUpserter) setMappedBool(key string, value *bool, trueValue, falseValue string) {
	if value == nil {
		return
	}
	if *value {
		u.upsert(key, trueValue)
		return
	}
	u.upsert(key, falseValue)
}

func (u *settingsUpserter) setNonEmptyString(key string, value *string) {
	if value != nil && *value != "" {
		u.upsert(key, *value)
	}
}

func (u *settingsUpserter) setPositiveInt(key string, value *int) {
	if value != nil && *value > 0 {
		u.upsert(key, strconv.Itoa(*value))
	}
}

func (h *Handler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req updateSettingsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, errInvalidRequest)
		return
	}

	upserter := newSettingsUpserter(ctx, h.db)
	upserter.setString("app_name", req.SiteName)
	upserter.setBool("allow_registrations", req.AllowRegistrations)
	upserter.setBool("require_invite", req.RequireInvite)
	upserter.setInt64("default_quota_bytes", req.DefaultQuotaBytes)
	upserter.setInt64("max_upload_bytes", req.MaxUploadBytes)
	upserter.setString("direct_upload_url", req.DirectUploadURL)
	upserter.setString("smtp_host", req.SMTPHost)
	upserter.setInt("smtp_port", req.SMTPPort)
	upserter.setString("smtp_user", req.SMTPUsername)
	upserter.setString("smtp_password", req.SMTPPassword)
	upserter.setString("smtp_from", req.SMTPFromAddress)
	upserter.setMappedBool("smtp_tls", req.SMTPTls, "starttls", "none")
	upserter.setString("onlyoffice_url", req.OnlyOfficeURL)
	upserter.setNonEmptyString("onlyoffice_jwt_secret", req.OnlyOfficeJWTSecret)
	upserter.setPositiveInt("playlist_max_tracks", req.PlaylistMaxTracks)

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
		httputil.RespondError(w, http.StatusInternalServerError, errInternal)
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
	IP           string `json:"ip"`
	Tier         string `json:"tier"`
	TTLSeconds   *int64 `json:"ttl_seconds"`   // null = manual (no TTL)
	AttemptCount int64  `json:"attempt_count"` // total recorded failures
}

const lockoutKeyPrefix = "lockout:"
const lockoutFailuresSuffix = "failures:"
const errInternal = "internal error"
const errInvalidRequest = "invalid request"

func classifyLockoutTTL(ttl time.Duration) (string, *int64) {
	if ttl <= 0 {
		return "manual", nil
	}
	secs := int64(ttl.Seconds())
	tier := "24h"
	switch {
	case secs <= 61*60:
		tier = "60m"
	case secs <= 7*60*60:
		tier = "6h"
	}
	return tier, &secs
}

func (h *Handler) blockedIPAttempts(ctx context.Context, ip string) int64 {
	attempts, err := h.rdb.Get(ctx, lockoutKeyPrefix+lockoutFailuresSuffix+ip).Int64()
	if err != nil {
		return 0
	}
	return attempts
}

func (h *Handler) blockedIPEntry(ctx context.Context, key string) (*blockedIPEntry, error) {
	if strings.HasPrefix(key, lockoutKeyPrefix+lockoutFailuresSuffix) {
		return nil, nil
	}
	ttl, err := h.rdb.TTL(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	ip := strings.TrimPrefix(key, lockoutKeyPrefix)
	tier, ttlSeconds := classifyLockoutTTL(ttl)
	return &blockedIPEntry{
		IP:           ip,
		Tier:         tier,
		TTLSeconds:   ttlSeconds,
		AttemptCount: h.blockedIPAttempts(ctx, ip),
	}, nil
}

// ListBlockedIPs lists IPs currently locked out (TTL-based entries in Redis).
func (h *Handler) ListBlockedIPs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	out := []blockedIPEntry{}

	var cursor uint64
	for {
		keys, next, err := h.rdb.Scan(ctx, cursor, lockoutKeyPrefix+"*", 100).Result()
		if err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, errInternal)
			return
		}
		for _, key := range keys {
			entry, err := h.blockedIPEntry(ctx, key)
			if err != nil || entry == nil {
				continue
			}
			out = append(out, *entry)
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}

	httputil.Respond(w, http.StatusOK, out)
}
func (h *Handler) UnblockIP(w http.ResponseWriter, r *http.Request) {
	ip := chi.URLParam(r, "ip")
	if ip == "" {
		httputil.RespondError(w, http.StatusBadRequest, "ip is required")
		return
	}
	ctx := r.Context()
	h.rdb.Del(ctx, lockoutKeyPrefix+ip)
	h.rdb.Del(ctx, lockoutKeyPrefix+lockoutFailuresSuffix+ip)
	// Also clear the rate limiter sliding-window counter so login is immediately allowed
	h.rdb.Del(ctx, "rl:ip_login:"+ip)
	// Also remove any DB-side manual block
	h.db.Exec(ctx,
		`DELETE FROM ip_whitelist WHERE ip_cidr = $1 AND description = 'Manually blocked by admin'`,
		ip+"/32",
	)
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
		httputil.RespondError(w, http.StatusInternalServerError, errInternal)
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
	// Validate IP or CIDR notation before storing.
	if strings.Contains(req.IPCIDR, "/") {
		if _, _, err := net.ParseCIDR(req.IPCIDR); err != nil {
			httputil.RespondError(w, http.StatusBadRequest, "invalid CIDR notation")
			return
		}
	} else {
		if net.ParseIP(req.IPCIDR) == nil {
			httputil.RespondError(w, http.StatusBadRequest, "invalid IP address")
			return
		}
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

type auditLogQueryParts struct {
	whereClause string
	args        []any
	limitIdx    int
	offsetIdx   int
}

func buildAuditLogQueryParts(q map[string][]string) auditLogQueryParts {
	limit := 100
	offset := 0
	if s := firstQueryValue(q, "limit"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	if s := firstQueryValue(q, "offset"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n >= 0 {
			offset = n
		}
	}

	var whereParts []string
	var args []any
	if eventType := firstQueryValue(q, "event_type"); eventType != "" {
		args = append(args, eventType)
		whereParts = append(whereParts, fmt.Sprintf("event_type = $%d", len(args)))
	}
	if actorEmail := firstQueryValue(q, "actor_email"); actorEmail != "" {
		safeEmail := strings.ReplaceAll(actorEmail, `\`, `\\`)
		safeEmail = strings.ReplaceAll(safeEmail, `%`, `\%`)
		safeEmail = strings.ReplaceAll(safeEmail, `_`, `\_`)
		args = append(args, "%"+safeEmail+"%")
		whereParts = append(whereParts, fmt.Sprintf("actor_email ILIKE $%d ESCAPE '\\'", len(args)))
	}

	whereClause := ""
	if len(whereParts) > 0 {
		whereClause = "WHERE " + strings.Join(whereParts, " AND ")
	}

	paginatedArgs := append(args, limit, offset)
	return auditLogQueryParts{
		whereClause: whereClause,
		args:        paginatedArgs,
		limitIdx:    len(paginatedArgs) - 1,
		offsetIdx:   len(paginatedArgs),
	}
}

func firstQueryValue(q map[string][]string, key string) string {
	if values, ok := q[key]; ok && len(values) > 0 {
		return values[0]
	}
	return ""
}

func (h *Handler) AuditLogs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	parts := buildAuditLogQueryParts(r.URL.Query())

	var total int
	_ = h.db.QueryRow(ctx, `SELECT count(*) FROM audit_logs `+parts.whereClause, parts.args[:len(parts.args)-2]...).Scan(&total)
	rows, err := h.db.Query(ctx,
		fmt.Sprintf(
			`SELECT id, event_type, actor_id::TEXT, actor_email,
			        target_user_id::TEXT, resource_type, resource_id::TEXT, resource_name,
			        metadata, ip_address, user_agent, is_admin_action, created_at
			 FROM audit_logs
			 %s
			 ORDER BY created_at DESC
			 LIMIT $%d OFFSET $%d`,
			parts.whereClause, parts.limitIdx, parts.offsetIdx,
		),
		parts.args...,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, errInternal)
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
		httputil.RespondError(w, http.StatusInternalServerError, errInternal)
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
		httputil.RespondError(w, http.StatusInternalServerError, errInternal)
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
		httputil.RespondError(w, http.StatusBadRequest, errInvalidRequest)
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
			httputil.RespondError(w, http.StatusInternalServerError, errInternal)
			return
		}
	}
	if req.Color != nil {
		if _, err := h.db.Exec(ctx, `UPDATE groups SET color = $1 WHERE id = $2`, *req.Color, id); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, errInternal)
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
		httputil.RespondError(w, http.StatusInternalServerError, errInternal)
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
		httputil.RespondError(w, http.StatusInternalServerError, errInternal)
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
		httputil.RespondError(w, http.StatusInternalServerError, errInternal)
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
		httputil.RespondError(w, http.StatusBadRequest, errInvalidRequest)
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
type scrubBlob struct {
	id   string
	path string
	size int64
}

func isScrubShard(entry os.DirEntry) bool {
	return entry.IsDir() && len(entry.Name()) == 2
}

func scrubBlobFromEntry(shardPath string, entry os.DirEntry) (scrubBlob, bool) {
	if entry.IsDir() {
		return scrubBlob{}, false
	}
	name := entry.Name()
	if len(name) != 36 {
		return scrubBlob{}, false
	}
	info, err := entry.Info()
	if err != nil {
		return scrubBlob{}, false
	}
	return scrubBlob{
		id:   name,
		path: filepath.Join(shardPath, name),
		size: info.Size(),
	}, true
}

func scanShardBlobs(filesRoot string, shard os.DirEntry) []scrubBlob {
	shardPath := filepath.Join(filesRoot, shard.Name())
	entries, err := os.ReadDir(shardPath)
	if err != nil {
		return nil
	}

	blobs := make([]scrubBlob, 0, len(entries))
	for _, entry := range entries {
		blob, ok := scrubBlobFromEntry(shardPath, entry)
		if ok {
			blobs = append(blobs, blob)
		}
	}
	return blobs
}

func scanStorageBlobs(filesRoot string) ([]scrubBlob, error) {
	entries, err := os.ReadDir(filesRoot)
	if err != nil {
		return nil, fmt.Errorf("storage scrub: read root: %w", err)
	}

	var blobs []scrubBlob
	for _, shard := range entries {
		if !isScrubShard(shard) {
			continue
		}
		blobs = append(blobs, scanShardBlobs(filesRoot, shard)...)
	}
	return blobs, nil
}

func knownScrubBlobIDs(ctx context.Context, db *pgxpool.Pool, batch []scrubBlob) (map[string]struct{}, error) {
	ids := make([]string, len(batch))
	for i, blob := range batch {
		ids[i] = blob.id
	}
	rows, err := db.Query(ctx, `SELECT id::text FROM files WHERE id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, fmt.Errorf("storage scrub: db query: %w", err)
	}
	defer rows.Close()

	known := make(map[string]struct{}, len(batch))
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			known[id] = struct{}{}
		}
	}
	return known, nil
}

func removeOrphanScrubBlobs(batch []scrubBlob, known map[string]struct{}, result *ScrubResult) {
	for _, blob := range batch {
		if _, exists := known[blob.id]; exists {
			continue
		}
		if err := os.Remove(blob.path); err != nil && !os.IsNotExist(err) {
			log.Warn().Str("path", blob.path).Err(err).Msg("storage scrub: failed to delete orphan")
			continue
		}
		result.DeletedBlobs++
		result.FreedBytes += blob.size
		log.Debug().Str("id", blob.id).Int64("bytes", blob.size).Msg("storage scrub: deleted orphan blob")
	}
}

func RunStorageScrub(ctx context.Context, db *pgxpool.Pool, filesRoot string) (*ScrubResult, error) {
	blobs, err := scanStorageBlobs(filesRoot)
	if err != nil {
		return nil, err
	}

	result := &ScrubResult{ScannedBlobs: int64(len(blobs))}
	const batchSize = 500
	for i := 0; i < len(blobs); i += batchSize {
		end := i + batchSize
		if end > len(blobs) {
			end = len(blobs)
		}
		batch := blobs[i:end]
		known, err := knownScrubBlobIDs(ctx, db, batch)
		if err != nil {
			return nil, err
		}
		removeOrphanScrubBlobs(batch, known, result)
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
		httputil.RespondError(w, http.StatusInternalServerError, errInternal)
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
