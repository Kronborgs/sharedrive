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
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/files"
	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

// Handler handles OnlyOffice editor integration.
type Handler struct {
	db      *pgxpool.Pool
	storage *files.Storage
	appBase string // e.g. https://files.example.com
}

// NewHandler creates a Handler.
func NewHandler(db *pgxpool.Pool, storage *files.Storage, appBase string) *Handler {
	return &Handler{db: db, storage: storage, appBase: strings.TrimRight(appBase, "/")}
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

type fileRow struct {
	id       string
	name     string
	ownerID  string
	mimeType string
	path     string // absolute path on disk
}

func (h *Handler) lookupFile(ctx context.Context, fileID, userID string) (*fileRow, error) {
	var f fileRow
	err := h.db.QueryRow(ctx,
		`SELECT id::text, name, owner_id::text, COALESCE(mime_type,''), storage_path
		   FROM files
		  WHERE id = $1::uuid AND owner_id = $2::uuid AND deleted_at IS NULL`,
		fileID, userID,
	).Scan(&f.id, &f.name, &f.ownerID, &f.mimeType, &f.path)
	if err != nil {
		return nil, err
	}
	// storage_path is the absolute on-disk path; keep as-is.
	return &f, nil
}

// ─── GET /api/v1/onlyoffice/config/{fileId} ──────────────────────────────────

type editorConfig struct {
	Document     docSection    `json:"document"`
	DocumentType string        `json:"documentType"`
	EditorConfig editorSection `json:"editorConfig"`
	Token        string        `json:"token,omitempty"`
}

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
	CallbackURL string `json:"callbackUrl"`
	Lang        string `json:"lang"`
	Mode        string `json:"mode"`
	User        edUser `json:"user"`
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
		httputil.RespondError(w, http.StatusNotFound, "file not found")
		return
	}

	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(f.name), "."))
	// Unique document key — changes every time so OO always fetches fresh content.
	// In a production multi-user collab setup you'd store and reuse this until the
	// document is force-saved, but for single-user operation this is fine.
	docKey := fmt.Sprintf("%s_%d", fileID, time.Now().Unix())

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

	cfg := editorConfig{
		Document: docSection{
			FileType:    ext,
			Key:         docKey,
			Title:       f.name,
			URL:         downloadURL,
			Permissions: docPerms{Edit: true, Download: true},
		},
		DocumentType: documentType(f.name),
		EditorConfig: editorSection{
			CallbackURL: fmt.Sprintf("%s/api/v1/onlyoffice/callback/%s", h.appBase, fileID),
			Lang:        "da",
			Mode:        "edit",
			User:        edUser{ID: actor.ID.String(), Name: actor.Email},
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

type callbackBody struct {
	Status int    `json:"status"`
	URL    string `json:"url"`
	Key    string `json:"key"`
	Token  string `json:"token"`
}

// Callback receives save events from the OnlyOffice document server.
// POST /api/v1/onlyoffice/callback/{fileId}
func (h *Handler) Callback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fileID := chi.URLParam(r, "fileId")

	_, jwtSecret, err := h.getSettings(ctx)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "settings error")
		return
	}

	var body callbackBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid body")
		return
	}

	// Verify JWT from OnlyOffice when secret is set
	if jwtSecret != "" {
		tok := body.Token
		if tok == "" {
			// Also check Authorization header
			auth := r.Header.Get("Authorization")
			tok = strings.TrimPrefix(auth, "Bearer ")
		}
		if _, err := verifyJWT(tok, jwtSecret); err != nil {
			log.Warn().Err(err).Str("file_id", fileID).Msg("onlyoffice callback JWT verification failed")
			httputil.RespondError(w, http.StatusUnauthorized, "invalid token")
			return
		}
	}

	// Status 2 = ready to save, Status 6 = force-save
	if body.Status == 2 || body.Status == 6 {
		if body.URL == "" {
			httputil.Respond(w, http.StatusOK, map[string]int{"error": 0})
			return
		}

		// Fetch the updated document from the OnlyOffice storage URL.
		resp, err := http.Get(body.URL) //nolint:gosec // URL comes from authenticated OO server
		if err != nil {
			log.Error().Err(err).Msg("onlyoffice: failed to fetch saved document")
			httputil.Respond(w, http.StatusOK, map[string]int{"error": 1})
			return
		}
		defer resp.Body.Close()

		// Write via storage — this transparently (re-)encrypts the file if
		// FILE_ENCRYPT_KEY is configured. The file is written to a temp path
		// and then atomically moved by Storage.Write().
		written, err := h.storage.Write(fileID, resp.Body)
		if err != nil {
			log.Error().Err(err).Msg("onlyoffice: storage write error")
			httputil.Respond(w, http.StatusOK, map[string]int{"error": 1})
			return
		}

		// Update size in DB
		_, _ = h.db.Exec(ctx,
			`UPDATE files SET size = $1, updated_at = now() WHERE id = $2::uuid`,
			written, fileID,
		)

		log.Info().Str("file_id", fileID).Int64("bytes", written).Msg("onlyoffice: document saved")
	}

	// Always return {"error":0} so OO knows we handled it
	httputil.Respond(w, http.StatusOK, map[string]int{"error": 0})
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
		httputil.RespondError(w, http.StatusNotFound, "file not found")
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

	// Verify user owns file
	var exists bool
	_ = h.db.QueryRow(ctx,
		`SELECT true FROM files WHERE id = $1::uuid AND owner_id = $2::uuid AND deleted_at IS NULL`,
		fileID, actor.ID.String(),
	).Scan(&exists)
	if !exists {
		httputil.RespondError(w, http.StatusNotFound, "file not found")
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
