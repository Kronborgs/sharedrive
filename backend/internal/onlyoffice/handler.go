// Package onlyoffice provides integration with an OnlyOffice Document Server.
// It exposes three HTTP endpoints:
//
//	GET  /api/v1/onlyoffice/config/{fileId}  — returns the editor config JSON + signed JWT
//	POST /api/v1/onlyoffice/callback/{fileId} — receives save callbacks from document server
//	GET  /api/v1/onlyoffice/download/{fileId} — serves the raw file to the document server
package onlyoffice

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/files"
	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

// Handler handles OnlyOffice editor integration.
type Handler struct {
	db      *pgxpool.Pool
	storage *files.Storage
	rdb     *goredis.Client // nil = no Redis; used for collaborative docKey caching
	appBase string          // e.g. https://files.example.com
}

// NewHandler creates a Handler.
func NewHandler(db *pgxpool.Pool, storage *files.Storage, appBase string, rdb *goredis.Client) *Handler {
	return &Handler{db: db, storage: storage, rdb: rdb, appBase: strings.TrimRight(appBase, "/")}
}

// ─── Settings helpers ────────────────────────────────────────────────────────

func (h *Handler) getSettings(ctx context.Context) (ooURL, jwtSecret string, err error) {
	rows, err := h.db.Query(ctx,
		`SELECT key, value FROM system_settings WHERE key IN ('onlyoffice_url','onlyoffice_jwt_secret')`)
	if err != nil {
		return "", "", err
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
	return kv["onlyoffice_url"], kv["onlyoffice_jwt_secret"], nil
}

// ─── JWT (HS256) ──────────────────────────────────────────────────────────────

type jwtHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
}

func signJWT(payload any, secret string) (string, error) {
	hdr, err := json.Marshal(jwtHeader{Alg: "HS256", Typ: "JWT"})
	if err != nil {
		return "", err
	}
	pay, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	hdrB64 := base64.RawURLEncoding.EncodeToString(hdr)
	payB64 := base64.RawURLEncoding.EncodeToString(pay)
	unsigned := hdrB64 + "." + payB64
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(unsigned))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return unsigned + "." + sig, nil
}

func verifyJWT(token, secret string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid token format")
	}
	unsigned := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(unsigned))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(parts[2])) {
		return nil, fmt.Errorf("invalid signature")
	}
	payJSON, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal(payJSON, &payload); err != nil {
		return nil, err
	}
	return payload, nil
}

// ─── File lookup ─────────────────────────────────────────────────────────────

// shareGrantClause is the condition used to match a share row against a user,
// including direct grants and group memberships.
// Bind: $2 = user UUID.
const shareGrantClause = `(
  (sh.grantee_type = 'user'  AND sh.grantee_id = $2::uuid)
  OR (sh.grantee_type = 'group' AND sh.grantee_id IN (
        SELECT group_id FROM group_members WHERE user_id = $2::uuid
  ))
)`

type fileRow struct {
	id       string
	name     string
	ownerID  string
	mimeType string
	path     string // absolute path on disk
	canEdit  bool   // true when user owns file or has an active can_edit share
}

// lookupFile returns the file if the user owns it or has any active share grant
// for it (including grants on ancestor folders).
// The canEdit field reflects whether the user may write changes.
func (h *Handler) lookupFile(ctx context.Context, fileID, userID string) (*fileRow, error) {
	var f fileRow
	err := h.db.QueryRow(ctx, `
		WITH RECURSIVE anc AS (
		  SELECT id, parent_id FROM files WHERE id = $1::uuid AND deleted_at IS NULL
		  UNION ALL
		  SELECT p.id, p.parent_id FROM files p
		  JOIN anc ON p.id = anc.parent_id
		  WHERE p.deleted_at IS NULL
		)
		SELECT f.id::text, f.name, f.owner_id::text, COALESCE(f.mime_type,''), f.storage_path,
		       (f.owner_id = $2::uuid OR EXISTS(
		         SELECT 1 FROM shares sh
		         JOIN anc ON sh.resource_id = anc.id
		         WHERE sh.can_edit = true
		           AND sh.revoked_at IS NULL
		           AND (sh.expires_at IS NULL OR sh.expires_at > now())
		           AND `+shareGrantClause+`
		       )) AS can_edit
		  FROM files f
		 WHERE f.id = $1::uuid AND f.deleted_at IS NULL
		   AND (
		     f.owner_id = $2::uuid
		     OR EXISTS(
		       SELECT 1 FROM shares sh
		       JOIN anc ON sh.resource_id = anc.id
		       WHERE sh.revoked_at IS NULL
		         AND (sh.expires_at IS NULL OR sh.expires_at > now())
		         AND `+shareGrantClause+`
		     )
		   )`,
		fileID, userID,
	).Scan(&f.id, &f.name, &f.ownerID, &f.mimeType, &f.path, &f.canEdit)
	if err != nil {
		return nil, err
	}
	return &f, nil
}

// ─── docKey Redis helpers ─────────────────────────────────────────────────────

const (
	ooDocKeyPrefix = "oo_dockey:"
	ooDocKeyTTL    = 24 * time.Hour
)

// getOrCreateDocKey returns a stable docKey for fileID from Redis, generating
// and storing a fresh one when none exists. Falls back to a timestamp key when
// Redis is unavailable so editing still functions.
func (h *Handler) getOrCreateDocKey(ctx context.Context, fileID string) string {
	redisKey := ooDocKeyPrefix + fileID
	if h.rdb != nil {
		if v, err := h.rdb.Get(ctx, redisKey).Result(); err == nil && v != "" {
			return v
		}
	}
	key := fmt.Sprintf("%s_%d", fileID, time.Now().UnixMilli())
	if h.rdb != nil {
		_ = h.rdb.Set(ctx, redisKey, key, ooDocKeyTTL).Err()
	}
	return key
}

// invalidateDocKey removes the cached docKey for a file after a successful save,
// so the next edit session gets a fresh key pointing at the updated content.
func (h *Handler) invalidateDocKey(ctx context.Context, fileID string) {
	if h.rdb != nil {
		_ = h.rdb.Del(ctx, ooDocKeyPrefix+fileID).Err()
	}
}

// ─── GET /api/v1/onlyoffice/config/{fileId} ──────────────────────────────────

type editorConfig struct {
	Document     docSection    `json:"document"`
	DocumentType string        `json:"documentType"`
	EditorConfig editorSection `json:"editorConfig"`
	Events       edEvents      `json:"events,omitempty"`
	Token        string        `json:"token,omitempty"`
}

// edEvents is left empty but present so we can extend it later.
type edEvents struct{}

type docSection struct {
	FileType    string   `json:"fileType"`
	Key         string   `json:"key"`
	Title       string   `json:"title"`
	URL         string   `json:"url"`
	Permissions docPerms `json:"permissions"`
}

type docPerms struct {
	Edit     bool `json:"edit"`
	Download bool `json:"download"`
}

type editorSection struct {
	CallbackURL string    `json:"callbackUrl"`
	Lang        string    `json:"lang"`
	Mode        string    `json:"mode"`
	User        edUser    `json:"user"`
	Plugins     edPlugins `json:"plugins"`
}

// edPlugins disables all server-side OO plugins to prevent 404s for
// missing plugin translation files (e.g. the built-in AI assistant).
type edPlugins struct {
	PluginsData []string `json:"pluginsData"`
}

type edUser struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// documentType resolves OnlyOffice document type from file extension.
// Valid values: word, cell, slide, pdf, diagram
func documentType(name string) string {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	switch ext {
	case "xls", "xlsx", "xlsm", "xlsb", "xltx", "csv", "ods", "ots", "fods":
		return "cell"
	case "ppt", "pptx", "pptm", "potx", "odp", "otp", "fodp":
		return "slide"
	default:
		return "word"
	}
}

// GetEditorConfig returns the OnlyOffice editor configuration JSON.
// GET /api/v1/onlyoffice/config/{fileId}
func (h *Handler) GetEditorConfig(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := middleware.UserFromContext(ctx)
	fileID := chi.URLParam(r, "fileId")

	ooURL, jwtSecret, err := h.getSettings(ctx)
	if err != nil || ooURL == "" {
		httputil.RespondError(w, http.StatusServiceUnavailable, "OnlyOffice not configured")
		return
	}

	f, err := h.lookupFile(ctx, fileID, actor.ID.String())
	if err != nil {
		httputil.RespondError(w, http.StatusNotFound, onlyOfficeErrFileNotFound)
		return
	}

	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(f.name), "."))
	// docKey is stored in Redis so all concurrent editors share the same key,
	// enabling OO's collaborative real-time sync. Invalidated on save.
	docKey := h.getOrCreateDocKey(ctx, fileID)

	// Build the download URL. When a JWT secret is configured the Download endpoint
	// requires a signed token, so we generate one now and embed it as a query param.
	// The OO document server fetches this URL server-side, so it must be fully
	// authenticated without browser session cookies.
	downloadURL := fmt.Sprintf("%s/api/v1/onlyoffice/download/%s", h.appBase, fileID)
	if jwtSecret != "" {
		dlTokenPayload := map[string]any{
			"file_id": fileID,
			"sub":     actor.ID.String(),
			"exp":     time.Now().Add(6 * time.Hour).Unix(),
		}
		if dlTok, err := signJWT(dlTokenPayload, jwtSecret); err == nil {
			downloadURL += "?token=" + dlTok
		}
	}

	mode := "edit"
	if !f.canEdit {
		mode = "view"
	}
	cfg := editorConfig{
		Document: docSection{
			FileType:    ext,
			Key:         docKey,
			Title:       f.name,
			URL:         downloadURL,
			Permissions: docPerms{Edit: f.canEdit, Download: true},
		},
		DocumentType: documentType(f.name),
		EditorConfig: editorSection{
			CallbackURL: fmt.Sprintf("%s/api/v1/onlyoffice/callback/%s", h.appBase, fileID),
			Lang:        "da",
			Mode:        mode,
			User:        edUser{ID: actor.ID.String(), Name: actor.Email},
			// Empty slice disables all server-side plugins (stops AI plugin 404s).
			Plugins: edPlugins{PluginsData: []string{}},
		},
	}

	if jwtSecret != "" {
		tok, err := signJWT(cfg, jwtSecret)
		if err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "jwt error")
			return
		}
		cfg.Token = tok
	}

	httputil.Respond(w, http.StatusOK, cfg)
}

// ─── POST /api/v1/onlyoffice/callback/{fileId} ───────────────────────────────

const onlyOfficeErrFileNotFound = "file not found"

type callbackBody struct {
	Status int    `json:"status"`
	URL    string `json:"url"`
	Key    string `json:"key"`
	Token  string `json:"token"`
}

// ooReply writes the OnlyOffice-required response format: {"error":0} for success
// or {"error":1} for failure. OO only recognises this exact top-level shape —
// our generic httputil.Respond wrapper must NOT be used for callback responses.
func ooReply(w http.ResponseWriter, errCode int) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"error":%d}`, errCode)
}

// Callback receives save events from the OnlyOffice document server.
// POST /api/v1/onlyoffice/callback/{fileId}
func (h *Handler) Callback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fileID := chi.URLParam(r, "fileId")

	_, jwtSecret, err := h.getSettings(ctx)
	if err != nil {
		log.Error().Err(err).Str("file_id", fileID).Msg("onlyoffice: failed to load settings")
		ooReply(w, 1)
		return
	}

	body, ok := decodeOnlyOfficeCallback(w, r, fileID)
	if !ok {
		return
	}

	log.Debug().Str("file_id", fileID).Int("status", body.Status).Msg("onlyoffice: callback received")
	if !verifyOnlyOfficeCallbackJWT(w, r, fileID, body, jwtSecret) {
		return
	}
	if !shouldPersistOnlyOfficeCallback(body) {
		ooReply(w, 0)
		return
	}
	if !h.persistOnlyOfficeCallback(ctx, w, fileID, body.URL) {
		return
	}

	ooReply(w, 0)
}

func decodeOnlyOfficeCallback(w http.ResponseWriter, r *http.Request, fileID string) (callbackBody, bool) {
	var body callbackBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		log.Warn().Err(err).Str("file_id", fileID).Msg("onlyoffice: invalid callback body")
		ooReply(w, 1)
		return callbackBody{}, false
	}
	return body, true
}

func verifyOnlyOfficeCallbackJWT(w http.ResponseWriter, r *http.Request, fileID string, body callbackBody, jwtSecret string) bool {
	if jwtSecret == "" {
		return true
	}
	tok := callbackJWTToken(r, body)
	if tok == "" {
		log.Warn().Str("file_id", fileID).Msg("onlyoffice: JWT secret configured but callback sent no token — check OO JWT settings")
		ooReply(w, 1)
		return false
	}
	if _, err := verifyJWT(tok, jwtSecret); err != nil {
		log.Warn().Err(err).Str("file_id", fileID).Msg("onlyoffice: callback JWT verification failed — secret mismatch?")
		ooReply(w, 1)
		return false
	}
	return true
}

func callbackJWTToken(r *http.Request, body callbackBody) string {
	if body.Token != "" {
		return body.Token
	}
	return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
}

func shouldPersistOnlyOfficeCallback(body callbackBody) bool {
	if body.Status != 2 && body.Status != 6 {
		return false
	}
	return body.URL != ""
}

func (h *Handler) persistOnlyOfficeCallback(ctx context.Context, w http.ResponseWriter, fileID, sourceURL string) bool {
	fetchCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, sourceURL, nil) //nolint:gosec
	if err != nil {
		log.Error().Err(err).Str("file_id", fileID).Msg("onlyoffice: failed to build fetch request")
		ooReply(w, 1)
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Error().Err(err).Str("url", sourceURL).Str("file_id", fileID).Msg("onlyoffice: failed to fetch saved document")
		ooReply(w, 1)
		return false
	}
	defer resp.Body.Close()

	written, err := h.storage.Write(fileID, resp.Body)
	if err != nil {
		log.Error().Err(err).Str("file_id", fileID).Msg("onlyoffice: storage write error")
		ooReply(w, 1)
		return false
	}

	_, _ = h.db.Exec(ctx,
		`UPDATE files SET size = $1, updated_at = now() WHERE id = $2::uuid`,
		written, fileID,
	)
	h.invalidateDocKey(ctx, fileID)
	log.Info().Str("file_id", fileID).Int64("bytes", written).Msg("onlyoffice: document saved")
	return true
}

// ─── GET /api/v1/onlyoffice/download/{fileId} ────────────────────────────────

// Download serves the raw file bytes to the OnlyOffice document server.
// The request comes from OO, not from the browser, so we auth via a signed
// query param token that the frontend included in the document URL.
// GET /api/v1/onlyoffice/download/{fileId}?token=<jwt>
func (h *Handler) Download(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fileID := chi.URLParam(r, "fileId")

	_, jwtSecret, err := h.getSettings(ctx)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "settings error")
		return
	}

	// Verify the download token
	token := r.URL.Query().Get("token")
	if jwtSecret != "" {
		if token == "" {
			httputil.RespondError(w, http.StatusUnauthorized, "missing token")
			return
		}
		claims, err := verifyJWT(token, jwtSecret)
		if err != nil {
			httputil.RespondError(w, http.StatusUnauthorized, "invalid token")
			return
		}
		// Check file_id claim matches
		if fid, _ := claims["file_id"].(string); fid != fileID {
			httputil.RespondError(w, http.StatusForbidden, "token mismatch")
			return
		}
		// Check expiry
		if exp, ok := claims["exp"].(float64); ok {
			if time.Now().Unix() > int64(exp) {
				httputil.RespondError(w, http.StatusUnauthorized, "token expired")
				return
			}
		}
	}

	var name string
	err = h.db.QueryRow(ctx,
		`SELECT name FROM files WHERE id = $1::uuid AND deleted_at IS NULL`,
		fileID,
	).Scan(&name)
	if err != nil {
		httputil.RespondError(w, http.StatusNotFound, onlyOfficeErrFileNotFound)
		return
	}

	rc, err := h.storage.Open(fileID)
	if err != nil {
		httputil.RespondError(w, http.StatusNotFound, "file not readable")
		return
	}
	defer rc.Close()

	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	http.ServeContent(w, r, name, time.Time{}, rc)
}

// MakeDownloadToken creates a short-lived signed token for a specific file,
// used by the frontend to embed in the document URL passed to OnlyOffice.
// GET /api/v1/onlyoffice/token/{fileId}
func (h *Handler) MakeDownloadToken(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := middleware.UserFromContext(ctx)
	fileID := chi.URLParam(r, "fileId")

	_, jwtSecret, err := h.getSettings(ctx)
	if err != nil || jwtSecret == "" {
		// No secret configured — return empty token, download endpoint won't check
		httputil.Respond(w, http.StatusOK, map[string]string{"token": ""})
		return
	}

	// Verify user owns or has share access to the file (including ancestor folder shares)
	var exists bool
	_ = h.db.QueryRow(ctx, `
		WITH RECURSIVE anc AS (
		  SELECT id, parent_id FROM files WHERE id = $1::uuid AND deleted_at IS NULL
		  UNION ALL
		  SELECT p.id, p.parent_id FROM files p
		  JOIN anc ON p.id = anc.parent_id
		  WHERE p.deleted_at IS NULL
		)
		SELECT true FROM files f
		 WHERE f.id = $1::uuid AND f.deleted_at IS NULL
		   AND (
		     f.owner_id = $2::uuid
		     OR EXISTS(
		       SELECT 1 FROM shares sh
		       JOIN anc ON sh.resource_id = anc.id
		       WHERE sh.revoked_at IS NULL
		         AND (sh.expires_at IS NULL OR sh.expires_at > now())
		         AND `+shareGrantClause+`
		     )
		   )`,
		fileID, actor.ID.String(),
	).Scan(&exists)
	if !exists {
		httputil.RespondError(w, http.StatusNotFound, onlyOfficeErrFileNotFound)
		return
	}

	payload := map[string]any{
		"file_id": fileID,
		"sub":     actor.ID.String(),
		"exp":     time.Now().Add(2 * time.Hour).Unix(),
	}
	tok, err := signJWT(payload, jwtSecret)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "jwt error")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]string{"token": tok})
}

// Test checks whether the configured OnlyOffice Document Server is reachable.
//
//	GET /api/v1/onlyoffice/test
func (h *Handler) Test(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ooURL, _, err := h.getSettings(ctx)
	if err != nil || ooURL == "" {
		httputil.Respond(w, http.StatusOK, map[string]any{"ok": false, "error": "ikke konfigureret"})
		return
	}

	testURL := strings.TrimRight(ooURL, "/") + "/healthcheck"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, testURL, nil)
	if err != nil {
		httputil.Respond(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		httputil.Respond(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer resp.Body.Close()
	ok := resp.StatusCode >= 200 && resp.StatusCode < 400
	httputil.Respond(w, http.StatusOK, map[string]any{"ok": ok, "status": resp.StatusCode})
}
