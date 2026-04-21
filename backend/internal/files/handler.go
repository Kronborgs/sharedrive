package files

import (
	"archive/zip"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif" // register GIF decoder
	"image/jpeg"
	_ "image/png" // register PNG decoder
	"io"
	"math/big"
	mime_pkg "mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"net/url"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	goredis "github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
	yzip "github.com/yeka/zip"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // register WEBP decoder

	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
	"github.com/yourname/privatedrive/internal/preview"
	"github.com/yourname/privatedrive/internal/ratelimit"
)

// Handler provides HTTP handlers for the files API.
type Handler struct {
	svc       *Service
	trash     *TrashService
	auditSvc  audit.Logger
	redis     *goredis.Client
	converter *preview.Converter // nil when LibreOffice is not configured
	limiter   *ratelimit.Limiter // nil when Redis is unavailable
	ioTracker *IOTracker
}

// NewHandler creates a Handler.
func NewHandler(svc *Service, trash *TrashService, auditSvc audit.Logger, rdb *goredis.Client, conv *preview.Converter, lim *ratelimit.Limiter, ioTracker *IOTracker) *Handler {
	return &Handler{svc: svc, trash: trash, auditSvc: auditSvc, redis: rdb, converter: conv, limiter: lim, ioTracker: ioTracker}
}

// FolderSize handles GET /api/v1/files/{id}/size — recursive byte + file count.
func (h *Handler) FolderSize(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")

	sizeBytes, fileCount, err := h.svc.GetFolderSize(r.Context(), id, actor.ID.String())
	if err != nil {
		httputil.RespondError(w, http.StatusNotFound, "folder not found")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]int64{"size_bytes": sizeBytes, "file_count": fileCount})
}

// List handles GET /api/v1/files — list contents of a folder (default: root).
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	parentParam := r.URL.Query().Get("parent_id")

	var parentID *uuid.UUID
	if parentParam != "" {
		id, err := uuid.Parse(parentParam)
		if err != nil {
			httputil.RespondError(w, http.StatusBadRequest, "invalid parent_id")
			return
		}
		parentID = &id
	}

	files, err := h.svc.List(r.Context(), actor.ID.String(), parentID)
	if err != nil {
		log.Error().Err(err).Msg("files.List")
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, files)
}

// Get handles GET /api/v1/files/{id}
func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")

	f, err := h.svc.GetAccessible(r.Context(), id, actor.ID.String())
	if err != nil || f == nil {
		httputil.RespondError(w, http.StatusNotFound, "file not found")
		return
	}
	httputil.Respond(w, http.StatusOK, f)
}

// CreateFolder handles POST /api/v1/files — creates a new folder.
func (h *Handler) CreateFolder(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	ctx := r.Context()

	var body struct {
		Name     string  `json:"name"`
		ParentID *string `json:"parent_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		httputil.RespondError(w, http.StatusBadRequest, "name is required")
		return
	}

	var parentID *uuid.UUID
	if body.ParentID != nil {
		id, err := uuid.Parse(*body.ParentID)
		if err != nil {
			httputil.RespondError(w, http.StatusBadRequest, "invalid parent_id")
			return
		}
		parentID = &id
	}

	f, err := h.svc.CreateFolder(ctx, actor.ID.String(), body.Name, parentID)
	if err != nil {
		log.Error().Err(err).Msg("files.CreateFolder")
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusCreated, f)
}

// Update handles PATCH /api/v1/files/{id} — rename or move.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")
	ctx := r.Context()

	var body struct {
		Name     *string `json:"name"`
		ParentID *string `json:"parent_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}

	if body.Name != nil {
		if err := h.svc.Rename(ctx, id, actor.ID.String(), *body.Name); err != nil {
			httputil.RespondError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if body.ParentID != nil {
		var newParent *uuid.UUID
		if *body.ParentID != "" {
			uid, err := uuid.Parse(*body.ParentID)
			if err != nil {
				httputil.RespondError(w, http.StatusBadRequest, "invalid parent_id")
				return
			}
			newParent = &uid
		}
		if err := h.svc.Move(ctx, id, actor.ID.String(), newParent); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "move failed")
			return
		}
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// Copy handles POST /api/v1/files/{id}/copy — duplicates a file to a destination folder.
// Body (all optional): { "destination_folder_id": "uuid" }
// Omitting destination_folder_id copies to the same folder as the source.
// Returns the new file record.
func (h *Handler) Copy(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")
	ctx := r.Context()

	var body struct {
		DestinationFolderID *string `json:"destination_folder_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && err.Error() != "EOF" {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	var destParentID *uuid.UUID
	if body.DestinationFolderID != nil && *body.DestinationFolderID != "" {
		uid, err := uuid.Parse(*body.DestinationFolderID)
		if err != nil {
			httputil.RespondError(w, http.StatusBadRequest, "invalid destination_folder_id")
			return
		}
		destParentID = &uid
	}

	f, err := h.svc.Copy(ctx, id, actor.ID.String(), destParentID)
	if err != nil {
		log.Error().Err(err).Msg("files.Copy")
		if err.Error() == "quota exceeded" {
			httputil.RespondError(w, http.StatusUnprocessableEntity, "quota exceeded")
			return
		}
		httputil.RespondError(w, http.StatusBadRequest, err.Error())
		return
	}
	httputil.Respond(w, http.StatusCreated, f)
}

// Delete handles DELETE /api/v1/files/{id} — soft-delete (moves to trash).
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")
	ctx := r.Context()

	fileName := h.svc.GetNameByID(ctx, id)
	if err := h.trash.SoftDelete(ctx, id, actor.ID.String()); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, err.Error())
		return
	}
	h.auditSvc.Log(ctx, audit.Event{
		Type:         audit.EventFileDeleted,
		ActorID:      &actor.ID,
		ActorEmail:   actor.Email,
		ResourceName: fileName,
		IPAddress:    middleware.ClientIP(r),
		Metadata:     map[string]any{"file_id": id},
	})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// Download handles GET /api/v1/files/{id}/download — streams file bytes.
func (h *Handler) Download(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")
	ctx := r.Context()

	// Per-user and per-IP download rate limiting (200/hour per user, 600/hour per IP).
	if h.limiter != nil {
		userOK, _, _, _ := h.limiter.Allow(ctx, ratelimit.KeyUserDownload, actor.ID.String(), 200, time.Hour)
		if !userOK {
			w.Header().Set("Retry-After", "3600")
			httputil.RespondError(w, http.StatusTooManyRequests, "download rate limit exceeded — try again later")
			return
		}
		ip := middleware.ClientIP(r)
		ipOK, _, _, _ := h.limiter.Allow(ctx, ratelimit.KeyIPDownload, ip, 600, time.Hour)
		if !ipOK {
			w.Header().Set("Retry-After", "3600")
			httputil.RespondError(w, http.StatusTooManyRequests, "download rate limit exceeded — try again later")
			return
		}
	}

	f, err := h.svc.GetAccessible(ctx, id, actor.ID.String())
	if err != nil || f == nil || f.IsFolder {
		httputil.RespondError(w, http.StatusNotFound, "file not found")
		return
	}

	reader, err := h.svc.storage.Open(id)
	if err != nil {
		log.Error().Err(err).Str("file_id", id).Msg("files.Download: open storage")
		httputil.RespondError(w, http.StatusInternalServerError, "could not open file")
		return
	}
	defer reader.Close()

	mime := f.MimeType
	if mime == "" {
		mime = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Length", strconv.FormatInt(f.SizeBytes, 10))
	w.Header().Set("Content-Disposition", contentDisposition("attachment", f.Name))
	w.Header().Set("Cache-Control", "private")
	http.ServeContent(w, r, f.Name, f.UpdatedAt, reader)

	// Use a background context: by the time ServeContent returns for large files,
	// the request context may already be cancelled (client disconnect).
	auditCtx, auditCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer auditCancel()

	// Track I/O bytes in Redis for the admin bandwidth dashboard.
	go h.ioTracker.TrackDownload(context.Background(), actor.ID.String(), f.SizeBytes)

	h.auditSvc.Log(auditCtx, audit.Event{
		Type:          audit.EventFileDownloaded,
		ActorID:       &actor.ID,
		ResourceID:    &f.ID,
		ResourceName:  f.Name,
		IPAddress:     middleware.ClientIP(r),
		IsAdminAction: middleware.IsSupportMode(ctx),
	})
}

// Recent handles GET /api/v1/files/recent
func (h *Handler) Recent(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	files, err := h.svc.Recent(r.Context(), actor.ID.String(), 50)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, files)
}

// Search handles GET /api/v1/files/search?q=... — returns matching files/folders.
func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 2 {
		httputil.Respond(w, http.StatusOK, []*File{})
		return
	}
	results, err := h.svc.Search(r.Context(), actor.ID.String(), q, 20)
	if err != nil {
		log.Error().Err(err).Msg("files.Search")
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, results)
}

// ListTrash handles GET /api/v1/files/trash
func (h *Handler) ListTrash(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	files, err := h.trash.ListTrash(r.Context(), actor.ID.String())
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, files)
}

// RestoreTrash handles POST /api/v1/files/trash/{id}/restore
func (h *Handler) RestoreTrash(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")
	ctx := r.Context()

	if err := h.trash.Restore(ctx, id, actor.ID.String()); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, err.Error())
		return
	}
	h.auditSvc.Log(ctx, audit.Event{
		Type:      audit.EventFileRestored,
		ActorID:   &actor.ID,
		IPAddress: middleware.ClientIP(r),
		Metadata:  map[string]any{"file_id": id},
	})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// PermanentDelete handles DELETE /api/v1/files/trash/{id}
func (h *Handler) PermanentDelete(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")
	ctx := r.Context()

	fileName := h.svc.GetNameByID(ctx, id)
	if err := h.trash.PermanentDelete(ctx, id, actor.ID.String()); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, err.Error())
		return
	}
	h.auditSvc.Log(ctx, audit.Event{
		Type:         audit.EventFilePermanentDeleted,
		ActorID:      &actor.ID,
		ActorEmail:   actor.Email,
		ResourceName: fileName,
		IPAddress:    middleware.ClientIP(r),
		Metadata:     map[string]any{"file_id": id},
	})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// EmptyTrash handles DELETE /api/v1/files/trash — permanently deletes all trashed files.
func (h *Handler) EmptyTrash(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	ctx := r.Context()

	if err := h.trash.EmptyTrashAll(ctx, actor.ID.String()); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	h.auditSvc.Log(ctx, audit.Event{
		Type:      audit.EventFilePermanentDeleted,
		ActorID:   &actor.ID,
		IPAddress: middleware.ClientIP(r),
		Metadata:  map[string]any{"empty_trash": true},
	})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// Breadcrumbs handles GET /api/v1/files/breadcrumbs?folder_id=<uuid>
// Returns the ancestor chain from root to the specified folder (root first, folder last).
func (h *Handler) Breadcrumbs(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	folderID := r.URL.Query().Get("folder_id")
	if folderID == "" {
		httputil.Respond(w, http.StatusOK, []BreadcrumbItem{})
		return
	}
	crumbs, err := h.svc.Breadcrumbs(r.Context(), folderID, actor.ID.String())
	if err != nil {
		log.Error().Err(err).Msg("files.Breadcrumbs")
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, crumbs)
}

// Upload handles POST /api/v1/files/upload — multipart file upload.
func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	ctx := r.Context()

	// Read folder_id from URL query string ONLY — calling r.FormValue here
	// would trigger ParseMultipartForm internally, consuming the body before
	// MaxBytesReader is applied.  folder_id from the body is re-read below.
	folderIDQuery := r.URL.Query().Get("folder_id")
	maxBytes := h.svc.GetEffectiveMaxUpload(ctx, actor.ID.String(), actor.Role, folderIDQuery)
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+1024*1024) // +1 MB form overhead

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		httputil.RespondError(w, http.StatusRequestEntityTooLarge, "file exceeds the maximum upload size for this account")
		return
	}

	// folder_id may have been in the multipart body rather than the URL.
	folderID := r.FormValue("folder_id")
	// If the effective limit changes (guest → folder owner), re-check against file size.
	if folderID != folderIDQuery {
		maxBytes = h.svc.GetEffectiveMaxUpload(ctx, actor.ID.String(), actor.Role, folderID)
	}

	fileData, header, err := r.FormFile("file")
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "file is required")
		return
	}
	defer fileData.Close()

	// Post-parse size guard (handles folder_id-from-body case above).
	if header.Size > maxBytes {
		httputil.RespondError(w, http.StatusRequestEntityTooLarge, "file exceeds the maximum upload size for this account")
		return
	}

	mimeType := header.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	f, err := h.svc.Upload(r.Context(), actor.ID.String(), header.Filename, mimeType, folderID, fileData, header.Size)
	if err != nil {
		if strings.HasPrefix(err.Error(), "quota:") {
			httputil.RespondError(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		log.Error().Err(err).Msg("files.Upload")
		httputil.RespondError(w, http.StatusInternalServerError, "upload failed")
		return
	}

	// Track I/O bytes in Redis for the admin bandwidth dashboard.
	go h.ioTracker.TrackUpload(context.Background(), actor.ID.String(), f.SizeBytes)

	httputil.Respond(w, http.StatusCreated, f)
}

// ── Utility helpers ─────────────────────────────────────────────────────────────────────

// contentDisposition returns a Content-Disposition header value with an ASCII
// fallback filename and an RFC 5987 / RFC 8187 filename* parameter so that
// non-ASCII characters (e.g. Danish ÆØÅ) survive in all modern browsers.
func contentDisposition(dispositionType, filename string) string {
	// Build an ASCII-safe fallback: replace non-ASCII bytes and embedded quotes.
	b := make([]byte, 0, len(filename))
	for i := 0; i < len(filename); i++ {
		c := filename[i]
		if c > 0x7f || c == '"' {
			b = append(b, '_')
		} else {
			b = append(b, c)
		}
	}
	// RFC 5987 percent-encoding of the UTF-8 filename.
	encoded := url.PathEscape(filename)
	return fmt.Sprintf(`%s; filename="%s"; filename*=UTF-8''%s`, dispositionType, string(b), encoded)
}

// safeZipName sanitizes an archive entry path to prevent directory-traversal
// attacks when the recipient extracts the ZIP. Any component that is "..",
// ".", empty, or all-whitespace is dropped.
func safeZipName(rawPath string) string {
	// Normalise both slash styles (for any Windows-sourced paths in the DB).
	cleaned := strings.ReplaceAll(rawPath, "\\", "/")
	parts := strings.Split(cleaned, "/")
	safe := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" || p == "." || p == ".." {
			continue
		}
		safe = append(safe, p)
	}
	if len(safe) == 0 {
		return "unnamed"
	}
	return strings.Join(safe, "/")
}

// isTextMIME returns true when the MIME type represents displayable text that
// should be truncated for safe, fast preview delivery.
func isTextMIME(mime string) bool {
	return strings.HasPrefix(mime, "text/") ||
		mime == "application/json" ||
		mime == "application/xml" ||
		mime == "application/javascript"
}

// ── Thumbnail ─────────────────────────────────────────────────────────────────

const (
	thumbnailMaxPx          = 256
	thumbnailMaxSourceBytes = 20 * 1024 * 1024 // 20 MB — refuse larger source images
)

// Thumbnail handles GET /api/v1/files/{id}/thumbnail.
// Returns a 256×256-capped JPEG thumbnail for image files.
// Non-image files and oversized sources return 404.
func (h *Handler) Thumbnail(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")
	ctx := r.Context()

	f, err := h.svc.GetAccessible(ctx, id, actor.ID.String())
	if err != nil || f == nil || f.IsFolder {
		httputil.RespondError(w, http.StatusNotFound, "file not found")
		return
	}

	// Only generate thumbnails for raster images; SVG is served via the preview endpoint.
	mime := f.MimeType
	if !strings.HasPrefix(mime, "image/") || mime == "image/svg+xml" {
		httputil.RespondError(w, http.StatusNotFound, "thumbnail not available")
		return
	}

	if f.SizeBytes > thumbnailMaxSourceBytes {
		httputil.RespondError(w, http.StatusNotFound, "source file too large for thumbnail")
		return
	}

	// Conditional request — ETag is the file's last-modified timestamp.
	etag := fmt.Sprintf(`"%s"`, f.UpdatedAt.UTC().Format(time.RFC3339))
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	reader, err := h.svc.storage.Open(id)
	if err != nil {
		log.Error().Err(err).Str("file_id", id).Msg("Thumbnail: open storage")
		httputil.RespondError(w, http.StatusInternalServerError, "could not open file")
		return
	}
	defer reader.Close()

	src, _, err := image.Decode(reader)
	if err != nil {
		// Format not decoded by registered decoders — return 404 so frontend falls back to icon.
		httputil.RespondError(w, http.StatusNotFound, "unsupported image format")
		return
	}

	thumb := thumbnailResize(src, thumbnailMaxPx)

	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.WriteHeader(http.StatusOK)
	_ = jpeg.Encode(w, thumb, &jpeg.Options{Quality: 85})
}

// thumbnailResize scales src down so neither dimension exceeds maxPx while
// preserving aspect ratio.  Uses bilinear interpolation for quality.
// Returns src unchanged when it is already within bounds.
func thumbnailResize(src image.Image, maxPx int) image.Image {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw == 0 || sh == 0 || (sw <= maxPx && sh <= maxPx) {
		return src
	}

	var tw, th int
	if sw >= sh {
		tw = maxPx
		th = sh * maxPx / sw
	} else {
		th = maxPx
		tw = sw * maxPx / sh
	}
	if tw < 1 {
		tw = 1
	}
	if th < 1 {
		th = 1
	}

	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	xdraw.BiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Over, nil)
	return dst
}

// ── Download ZIP ─────────────────────────────────────────────────────────────────

const (
	downloadTokenPrefix  = "download_token:"
	downloadTokenTTL     = 10 * time.Minute
	passwordAlphabet     = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"
	passwordLength       = 12
	customPasswordMaxLen = 128 // prevent oversized payloads being stored in Redis
)

// reDownloadToken matches the 64-character lowercase hex tokens produced by randomToken.
var reDownloadToken = regexp.MustCompile(`^[0-9a-f]{64}$`)

// randomPassword generates a cryptographically-secure 12-character password
// from a human-readable alphabet (no visually confusable characters: 0/O, 1/I/l).
func randomPassword() (string, error) {
	al := big.NewInt(int64(len(passwordAlphabet)))
	out := make([]byte, passwordLength)
	for i := range out {
		n, err := rand.Int(rand.Reader, al)
		if err != nil {
			return "", err
		}
		out[i] = passwordAlphabet[n.Int64()]
	}
	return string(out), nil
}

// randomToken generates a 32-byte hex token for short-lived download links.
func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", b), nil
}

// downloadTokenPayload is stored in Redis for prepare-download transactions.
type downloadTokenPayload struct {
	IDs      []string `json:"ids"`
	Password string   `json:"password"` // empty = no archive encryption
}

// PrepareDownloadRequest is the JSON body accepted by PrepareDownload.
type PrepareDownloadRequest struct {
	IDs            []string `json:"ids"`
	UsePassword    bool     `json:"use_password"`
	CustomPassword string   `json:"custom_password"`
}

// PrepareDownload handles POST /api/v1/files/prepare-download.
// Validates the requested IDs, generates an optional one-time password, and
// stores a short-lived Redis token that DownloadZip redeems via ?token=.
func (h *Handler) PrepareDownload(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Reject oversized bodies before decoding — prevent DoS via malformed JSON.
	// 500 UUIDs * ~40 bytes each + JSON overhead fits well within 64 KB.
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)

	var req PrepareDownloadRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.IDs) == 0 {
		httputil.RespondError(w, http.StatusBadRequest, "ids is required")
		return
	}
	if len(req.IDs) > 500 {
		httputil.RespondError(w, http.StatusBadRequest, "too many ids (max 500)")
		return
	}
	for _, id := range req.IDs {
		if _, err := uuid.Parse(strings.TrimSpace(id)); err != nil {
			httputil.RespondError(w, http.StatusBadRequest, "invalid id: "+id)
			return
		}
	}

	password := ""
	if req.UsePassword {
		if req.CustomPassword != "" {
			if len(req.CustomPassword) < 4 {
				httputil.RespondError(w, http.StatusBadRequest, "custom password must be at least 4 characters")
				return
			}
			if len(req.CustomPassword) > customPasswordMaxLen {
				httputil.RespondError(w, http.StatusBadRequest, "custom password too long (max 128 characters)")
				return
			}
			password = req.CustomPassword
		} else {
			var err error
			if password, err = randomPassword(); err != nil {
				log.Error().Err(err).Msg("PrepareDownload: randomPassword")
				httputil.RespondError(w, http.StatusInternalServerError, "internal error")
				return
			}
		}
	}

	token, err := randomToken()
	if err != nil {
		log.Error().Err(err).Msg("PrepareDownload: randomToken")
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	payload := downloadTokenPayload{IDs: req.IDs, Password: password}
	data, _ := json.Marshal(payload)
	if err := h.redis.Set(ctx, downloadTokenPrefix+token, string(data), downloadTokenTTL).Err(); err != nil {
		log.Error().Err(err).Msg("PrepareDownload: redis set")
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	resp := map[string]any{
		"token":      token,
		"expires_in": int(downloadTokenTTL.Seconds()),
	}
	if password != "" {
		resp["password"] = password
	}
	httputil.Respond(w, http.StatusOK, resp)
}

//	GET /api/v1/files/download-zip?ids=id1,id2,...  (plain ZIP, folders expanded)
//	GET /api/v1/files/download-zip?token=<token>    (optional AES-256 encryption)
//
// Folder IDs are expanded recursively in both code paths.
func (h *Handler) DownloadZip(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	ctx := r.Context()

	// Rate-limit both code paths uniformly before branching.
	if h.limiter != nil {
		userOK, _, _, _ := h.limiter.Allow(ctx, ratelimit.KeyUserZipDL, actor.ID.String(), 30, time.Hour)
		if !userOK {
			w.Header().Set("Retry-After", "3600")
			httputil.RespondError(w, http.StatusTooManyRequests, "ZIP download rate limit exceeded — try again later")
			return
		}
		ip := middleware.ClientIP(r)
		ipOK, _, _, _ := h.limiter.Allow(ctx, ratelimit.KeyIPZipDL, ip, 60, time.Hour)
		if !ipOK {
			w.Header().Set("Retry-After", "3600")
			httputil.RespondError(w, http.StatusTooManyRequests, "ZIP download rate limit exceeded — try again later")
			return
		}
	}

	// ── Token path (optionally encrypted) ─────────────────────────────────
	if token := strings.TrimSpace(r.URL.Query().Get("token")); token != "" {
		if !reDownloadToken.MatchString(token) {
			httputil.RespondError(w, http.StatusBadRequest, "invalid token format")
			return
		}
		h.downloadZipByToken(w, r, ctx, actor.ID, token)
		return
	}

	// ── Legacy ids= path (extended with recursive folder expansion) ────────
	rawIDs := r.URL.Query().Get("ids")
	if rawIDs == "" {
		httputil.RespondError(w, http.StatusBadRequest, "ids or token is required")
		return
	}
	ids := strings.Split(rawIDs, ",")
	if len(ids) > 100 {
		httputil.RespondError(w, http.StatusBadRequest, "too many ids (max 100)")
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="download.zip"`)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Accept-Ranges", "none")

	zw := zip.NewWriter(w)
	defer zw.Close()

	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if _, err := uuid.Parse(id); err != nil {
			continue
		}
		f, err := h.svc.GetAccessible(ctx, id, actor.ID.String())
		if err != nil || f == nil {
			continue
		}
		if f.IsFolder {
			h.streamFolderIntoZip(ctx, zw, id, actor.ID.String())
			continue
		}
		h.streamFileIntoZip(zw, id, f.Name)
	}
}

// downloadZipByToken redeems a prepare-download Redis token and streams a
// plain or AES-256-encrypted ZIP depending on the payload's password field.
func (h *Handler) downloadZipByToken(w http.ResponseWriter, r *http.Request, ctx context.Context, actorID uuid.UUID, token string) {
	userID := actorID.String()

	// Rate limiting is applied in the DownloadZip caller before this function
	// is invoked, so no duplicate check is needed here.

	data, err := h.redis.GetDel(ctx, downloadTokenPrefix+token).Result()
	if err != nil {
		httputil.RespondError(w, http.StatusNotFound, "download token not found or expired")
		return
	}

	var payload downloadTokenPayload
	if err := json.Unmarshal([]byte(data), &payload); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	// Audit at token-redemption time. The request context is still live here
	// (streaming hasn't started yet), so no need for a background context.
	h.auditSvc.Log(ctx, audit.Event{
		Type:          audit.EventZipDownloaded,
		ActorID:       &actorID,
		IPAddress:     middleware.ClientIP(r),
		IsAdminAction: middleware.IsSupportMode(ctx),
		Metadata:      map[string]any{"file_count": len(payload.IDs), "password_protected": payload.Password != ""},
	})

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="download.zip"`)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Accept-Ranges", "none")

	if payload.Password != "" {
		// AES-256 encrypted ZIP (yeka/zip)
		yzw := yzip.NewWriter(w)
		defer yzw.Close()
		for _, raw := range payload.IDs {
			id := strings.TrimSpace(raw)
			if _, err := uuid.Parse(id); err != nil {
				continue
			}
			f, err := h.svc.GetAccessible(ctx, id, userID)
			if err != nil || f == nil {
				continue
			}
			if f.IsFolder {
				h.streamFolderIntoEncryptedZip(ctx, yzw, id, userID, payload.Password)
				continue
			}
			h.streamFileIntoEncryptedZip(yzw, id, f.Name, payload.Password)
		}
	} else {
		// Plain ZIP
		zw := zip.NewWriter(w)
		defer zw.Close()
		for _, raw := range payload.IDs {
			id := strings.TrimSpace(raw)
			if _, err := uuid.Parse(id); err != nil {
				continue
			}
			f, err := h.svc.GetAccessible(ctx, id, userID)
			if err != nil || f == nil {
				continue
			}
			if f.IsFolder {
				h.streamFolderIntoZip(ctx, zw, id, userID)
				continue
			}
			h.streamFileIntoZip(zw, id, f.Name)
		}
	}
}

// streamFileIntoZip copies a single file from storage into a plain zip.Writer entry.
func (h *Handler) streamFileIntoZip(zw *zip.Writer, fileID, nameInZip string) {
	reader, err := h.svc.storage.Open(fileID)
	if err != nil {
		log.Warn().Err(err).Str("file_id", fileID).Msg("streamFileIntoZip: open")
		return
	}
	defer reader.Close()

	fw, err := zw.Create(safeZipName(nameInZip))
	if err != nil {
		log.Warn().Err(err).Str("file_id", fileID).Msg("streamFileIntoZip: create entry")
		return
	}
	if _, err := io.Copy(fw, reader); err != nil {
		log.Warn().Err(err).Str("file_id", fileID).Msg("streamFileIntoZip: copy")
	}
}

// streamFolderIntoZip recursively adds all descendants of folderID into a
// plain zip.Writer, preserving relative path structure. Access to the top-level
// folder was already verified by the caller; per-file re-checking is redundant
// and causes N+1 DB queries for large folders.
func (h *Handler) streamFolderIntoZip(ctx context.Context, zw *zip.Writer, folderID, _ string) {
	entries, err := h.svc.ListDescendantFiles(ctx, folderID)
	if err != nil {
		log.Warn().Err(err).Str("folder_id", folderID).Msg("streamFolderIntoZip: list")
		return
	}
	for _, e := range entries {
		h.streamFileIntoZip(zw, e.ID, e.PathInZip)
	}
}

// streamFileIntoEncryptedZip copies a single file into a yeka/zip AES-256 entry.
func (h *Handler) streamFileIntoEncryptedZip(yzw *yzip.Writer, fileID, nameInZip, password string) {
	reader, err := h.svc.storage.Open(fileID)
	if err != nil {
		log.Warn().Err(err).Str("file_id", fileID).Msg("streamFileIntoEncryptedZip: open")
		return
	}
	defer reader.Close()

	fw, err := yzw.Encrypt(safeZipName(nameInZip), password, yzip.AES256Encryption)
	if err != nil {
		log.Warn().Err(err).Str("file_id", fileID).Msg("streamFileIntoEncryptedZip: encrypt entry")
		return
	}
	if _, err := io.Copy(fw, reader); err != nil {
		log.Warn().Err(err).Str("file_id", fileID).Msg("streamFileIntoEncryptedZip: copy")
	}
}

// streamFolderIntoEncryptedZip recursively adds descendants of folderID into an
// AES-256 encrypted yeka/zip archive. Access to the top-level folder was already
// verified by the caller; per-file re-checking causes N+1 DB queries.
func (h *Handler) streamFolderIntoEncryptedZip(ctx context.Context, yzw *yzip.Writer, folderID, _ string, password string) {
	entries, err := h.svc.ListDescendantFiles(ctx, folderID)
	if err != nil {
		log.Warn().Err(err).Str("folder_id", folderID).Msg("streamFolderIntoEncryptedZip: list")
		return
	}
	for _, e := range entries {
		h.streamFileIntoEncryptedZip(yzw, e.ID, e.PathInZip, password)
	}
}

// Preview handles GET /api/v1/files/{id}/preview — streams a file inline for
// browser preview. Text-typed files are capped at 1 MB and the
// X-Preview-Truncated: true response header is set when truncation occurs.
// All other types use http.ServeContent which supports byte-range requests
// (required for video and audio seeking).
func (h *Handler) Preview(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")
	ctx := r.Context()

	f, err := h.svc.GetAccessible(ctx, id, actor.ID.String())
	if err != nil || f == nil || f.IsFolder {
		httputil.RespondError(w, http.StatusNotFound, "file not found")
		return
	}

	reader, err := h.svc.storage.Open(id)
	if err != nil {
		log.Error().Err(err).Str("file_id", id).Msg("files.Preview: open storage")
		httputil.RespondError(w, http.StatusInternalServerError, "could not open file")
		return
	}
	defer reader.Close()

	mime := f.MimeType
	// If the stored MIME is missing or the generic fallback used at upload time,
	// try to detect a more specific type from the file extension so that strict
	// desktop browsers (Chrome/Firefox) render the file correctly.
	if mime == "" || mime == "application/octet-stream" {
		if detected := mime_pkg.TypeByExtension(filepath.Ext(f.Name)); detected != "" {
			mime = detected
		}
	}
	if mime == "" {
		mime = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition", contentDisposition("inline", f.Name))
	w.Header().Set("Cache-Control", "private, no-store")

	const textPreviewLimit = 1 * 1024 * 1024 // 1 MB
	if isTextMIME(mime) && f.SizeBytes > textPreviewLimit {
		w.Header().Set("X-Preview-Truncated", "true")
		w.Header().Set("Content-Length", strconv.FormatInt(textPreviewLimit, 10))
		w.WriteHeader(http.StatusOK)
		_, _ = io.CopyN(w, reader, textPreviewLimit)
	} else {
		http.ServeContent(w, r, f.Name, f.UpdatedAt, reader)
	}

	// Use a background context so the audit event is not silently dropped when
	// the request context is cancelled by a client disconnect after the transfer.
}

// PreviewPDF handles GET /api/v1/files/{id}/preview/pdf — converts an Office
// document to PDF via LibreOffice and serves the cached result inline.
// Returns 503 Service Unavailable when LibreOffice is not configured.
func (h *Handler) PreviewPDF(w http.ResponseWriter, r *http.Request) {
	if h.converter == nil {
		httputil.RespondError(w, http.StatusServiceUnavailable, "PDF conversion not available on this server")
		return
	}

	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")
	ctx := r.Context()

	f, err := h.svc.GetAccessible(ctx, id, actor.ID.String())
	if err != nil || f == nil || f.IsFolder {
		httputil.RespondError(w, http.StatusNotFound, "file not found")
		return
	}

	sourcePath := h.svc.storage.Path(id)
	pdfPath, err := h.converter.PDFPath(ctx, id, sourcePath, f.Name, f.UpdatedAt)
	if err != nil {
		log.Error().Err(err).Str("file_id", id).Msg("files.PreviewPDF: convert")
		httputil.RespondError(w, http.StatusInternalServerError, "PDF conversion failed")
		return
	}

	pdfFile, err := os.Open(pdfPath)
	if err != nil {
		log.Error().Err(err).Str("pdf_path", pdfPath).Msg("files.PreviewPDF: open")
		httputil.RespondError(w, http.StatusInternalServerError, "could not open converted file")
		return
	}
	defer pdfFile.Close()

	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", contentDisposition("inline", f.Name+".pdf"))
	w.Header().Set("Cache-Control", "private, no-store")
	http.ServeContent(w, r, f.Name+".pdf", f.UpdatedAt, pdfFile)

	auditCtx, auditCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer auditCancel()
	h.auditSvc.Log(auditCtx, audit.Event{
		Type:          audit.EventFilePreviewed,
		ActorID:       &actor.ID,
		ResourceID:    &f.ID,
		ResourceName:  f.Name,
		IPAddress:     middleware.ClientIP(r),
		IsAdminAction: middleware.IsSupportMode(ctx),
		Metadata:      map[string]any{"via": "pdf_conversion"},
	})
}

// ── M3U Playlist ──────────────────────────────────────────────────────────────

// isAudioFilename returns true when the file is a recognised audio type.
func isAudioFilename(mimeType, name string) bool {
	if strings.HasPrefix(strings.ToLower(mimeType), "audio/") {
		return true
	}
	lower := strings.ToLower(name)
	for _, ext := range []string{".mp3", ".flac", ".wav", ".aac", ".m4a", ".opus", ".ogg"} {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

// CreatePlaylist handles POST /api/v1/files/playlist.
// Ignores any name/parent_id in the request body — always saves the file into
// the user's "Playlister" root folder (creating it if necessary) with a
// timestamped filename like "2026-04-19 14:30.m3u".
func (h *Handler) CreatePlaylist(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	ctx := r.Context()

	var body struct {
		FileIDs []string `json:"file_ids"`
		// name and parent_id are accepted but ignored — we generate them automatically.
		Name     string  `json:"name"`
		ParentID *string `json:"parent_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if len(body.FileIDs) == 0 {
		httputil.RespondError(w, http.StatusBadRequest, "no files specified")
		return
	}
	maxTracks := h.svc.PlaylistMaxTracks(ctx)
	if len(body.FileIDs) > maxTracks {
		httputil.RespondError(w, http.StatusBadRequest, fmt.Sprintf("playlist cannot exceed %d tracks", maxTracks))
		return
	}

	var sb strings.Builder
	sb.WriteString("#EXTM3U\n")
	validCount := 0
	for _, fid := range body.FileIDs {
		tf, err := h.svc.GetAccessible(ctx, fid, actor.ID.String())
		if err != nil || tf == nil || tf.IsFolder {
			continue // skip inaccessible or non-files
		}
		if !isAudioFilename(tf.MimeType, tf.Name) {
			continue // skip non-audio files
		}
		sb.WriteString(fmt.Sprintf("#SHAREDRIVE:id=%s\n", tf.ID.String()))
		sb.WriteString(tf.Name + "\n")
		validCount++
	}
	if validCount == 0 {
		httputil.RespondError(w, http.StatusBadRequest, "no accessible audio files in selection")
		return
	}

	// Ensure the "Playlister" folder exists in the user's root.
	playlistFolderID, err := h.svc.EnsurePlaylistFolder(ctx, actor.ID.String())
	if err != nil {
		log.Error().Err(err).Msg("files.CreatePlaylist: ensure folder")
		httputil.RespondError(w, http.StatusInternalServerError, "failed to ensure playlist folder")
		return
	}

	// Generate timestamped name: "2026-04-19 14:30.m3u"
	now := time.Now()
	fileName := now.Format("2006-01-02 15:04") + ".m3u"

	content := sb.String()
	f, err := h.svc.Upload(ctx, actor.ID.String(), fileName, "audio/mpegurl", playlistFolderID, strings.NewReader(content), int64(len(content)))
	if err != nil {
		log.Error().Err(err).Msg("files.CreatePlaylist")
		httputil.RespondError(w, http.StatusInternalServerError, "failed to save playlist")
		return
	}

	h.auditSvc.Log(ctx, audit.Event{
		Type:         audit.EventFileUploaded,
		ActorID:      &actor.ID,
		ResourceID:   &f.ID,
		ResourceName: f.Name,
		IPAddress:    middleware.ClientIP(r),
	})
	httputil.Respond(w, http.StatusCreated, f)
}

type playlistTrackResponse struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	PreviewURL string `json:"preview_url"`
	MimeType   string `json:"mime_type"`
}

// PlaylistTracks handles GET /api/v1/files/{id}/playlist/tracks.
// Reads an M3U file stored on disk, parses #SHAREDRIVE:id= lines,
// and returns resolved track info for tracks the user can still access.
func (h *Handler) PlaylistTracks(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")
	ctx := r.Context()

	// Verify access to the playlist file itself.
	f, err := h.svc.GetAccessible(ctx, id, actor.ID.String())
	if err != nil || f == nil {
		httputil.RespondError(w, http.StatusNotFound, "file not found")
		return
	}

	reader, err := h.svc.storage.Open(id)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "could not open playlist")
		return
	}
	defer reader.Close()

	data, err := io.ReadAll(io.LimitReader(reader, 1<<20)) // 1 MB max
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "could not read playlist")
		return
	}

	var tracks []playlistTrackResponse
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "#SHAREDRIVE:id=") {
			continue
		}
		trackID := strings.TrimPrefix(line, "#SHAREDRIVE:id=")
		trackID = strings.TrimSpace(trackID)
		if _, parseErr := uuid.Parse(trackID); parseErr != nil {
			continue
		}
		tf, tfErr := h.svc.GetAccessible(ctx, trackID, actor.ID.String())
		if tfErr != nil || tf == nil || tf.IsFolder {
			continue // skip inaccessible tracks
		}
		mt := tf.MimeType
		if mt == "" {
			mt = "audio/mpeg"
		}
		tracks = append(tracks, playlistTrackResponse{
			ID:         tf.ID.String(),
			Name:       tf.Name,
			PreviewURL: fmt.Sprintf("/api/v1/files/%s/preview", tf.ID.String()),
			MimeType:   mt,
		})
	}

	if tracks == nil {
		tracks = []playlistTrackResponse{}
	}
	httputil.Respond(w, http.StatusOK, tracks)
}

// UpdatePlaylist handles PUT /api/v1/files/{id}/playlist/tracks.
// Replaces the playlist content with a new ordered list of file IDs (1–50).
func (h *Handler) UpdatePlaylist(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")
	ctx := r.Context()

	// Verify ownership / write access
	f, err := h.svc.GetAccessible(ctx, id, actor.ID.String())
	if err != nil || f == nil || f.IsFolder {
		httputil.RespondError(w, http.StatusNotFound, "file not found")
		return
	}
	if !strings.HasSuffix(strings.ToLower(f.Name), ".m3u") {
		httputil.RespondError(w, http.StatusBadRequest, "not a playlist file")
		return
	}
	if f.OwnerID.String() != actor.ID.String() {
		httputil.RespondError(w, http.StatusForbidden, "only the owner can modify this playlist")
		return
	}

	var body struct {
		FileIDs []string `json:"file_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if len(body.FileIDs) == 0 {
		httputil.RespondError(w, http.StatusBadRequest, "no files specified")
		return
	}
	maxTracks := h.svc.PlaylistMaxTracks(ctx)
	if len(body.FileIDs) > maxTracks {
		httputil.RespondError(w, http.StatusBadRequest, fmt.Sprintf("playlist cannot exceed %d tracks", maxTracks))
		return
	}

	var sb strings.Builder
	sb.WriteString("#EXTM3U\n")
	validCount := 0
	for _, fid := range body.FileIDs {
		tf, tfErr := h.svc.GetAccessible(ctx, fid, actor.ID.String())
		if tfErr != nil || tf == nil || tf.IsFolder {
			continue
		}
		if !isAudioFilename(tf.MimeType, tf.Name) {
			continue
		}
		sb.WriteString(fmt.Sprintf("#SHAREDRIVE:id=%s\n", tf.ID.String()))
		sb.WriteString(tf.Name + "\n")
		validCount++
	}
	if validCount == 0 {
		httputil.RespondError(w, http.StatusBadRequest, "no accessible audio files in selection")
		return
	}

	if err := h.svc.ReplaceContent(ctx, id, strings.NewReader(sb.String())); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to update playlist")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// ── Text-file creation ───────────────────────────────────────────────────────

// CreateTextFile handles POST /api/v1/files/create-text — creates a new empty
// text file in the user's folder. The extension must be in the text-editor
// whitelist. Mirrors the OnlyOffice CreateDocument flow.
func (h *Handler) CreateTextFile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := middleware.UserFromContext(ctx)

	var req struct {
		Name     string  `json:"name"`
		ParentID *string `json:"parent_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httputil.RespondError(w, http.StatusBadRequest, "name is required")
		return
	}

	ext := textFileExt(req.Name)
	if !textEditorExtensions[ext] {
		httputil.RespondError(w, http.StatusBadRequest, "file type not supported")
		return
	}

	// Mime type lookup for common text types.
	mime := "text/plain"
	switch ext {
	case "json", "jsonc":
		mime = "application/json"
	case "html", "htm":
		mime = "text/html"
	case "xml":
		mime = "application/xml"
	case "css":
		mime = "text/css"
	case "js", "jsx":
		mime = "application/javascript"
	case "ts", "tsx":
		mime = "application/typescript"
	case "md", "markdown":
		mime = "text/markdown"
	case "yaml", "yml":
		mime = "text/yaml"
	case "sh", "bash", "zsh":
		mime = "application/x-sh"
	case "py":
		mime = "text/x-python"
	case "sql":
		mime = "application/sql"
	}

	// Validate parent folder — owner or shared with can_edit.
	var folderOwnerID string
	if req.ParentID != nil && *req.ParentID != "" {
		err := h.svc.db.QueryRow(ctx, `
			WITH RECURSIVE anc AS (
			  SELECT id, parent_id FROM files WHERE id = $1::uuid AND deleted_at IS NULL
			  UNION ALL
			  SELECT p.id, p.parent_id FROM files p
			  JOIN anc ON p.id = anc.parent_id
			  WHERE p.deleted_at IS NULL
			)
			SELECT f.owner_id::text
			  FROM files f
			 WHERE f.id = $1::uuid AND f.is_folder = true AND f.deleted_at IS NULL
			   AND (
			     f.owner_id = $2::uuid
			     OR EXISTS(
			       SELECT 1 FROM shares sh
			       JOIN anc ON sh.resource_id = anc.id
			       WHERE sh.can_edit = true
			         AND sh.revoked_at IS NULL
			         AND (sh.expires_at IS NULL OR sh.expires_at > now())
			         AND (
			           (sh.grantee_type = 'user'  AND sh.grantee_id = $2::uuid)
			           OR (sh.grantee_type = 'group' AND sh.grantee_id IN (
			                 SELECT group_id FROM group_members WHERE user_id = $2::uuid
			           ))
			         )
			     )
			   )`,
			*req.ParentID, actor.ID.String(),
		).Scan(&folderOwnerID)
		if err != nil {
			httputil.RespondError(w, http.StatusForbidden, "invalid parent folder")
			return
		}
	}

	newID := uuid.New()
	storagePath := h.svc.storage.Path(newID.String())

	// Write empty content.
	if _, err := h.svc.storage.Write(newID.String(), strings.NewReader("")); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "storage write failed")
		return
	}

	var parentParam *string
	if req.ParentID != nil && *req.ParentID != "" {
		parentParam = req.ParentID
	}

	fileOwner := actor.ID.String()
	if folderOwnerID != "" {
		fileOwner = folderOwnerID
	}

	type createResult struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	var result createResult
	err := h.svc.db.QueryRow(ctx,
		`INSERT INTO files (id, owner_id, parent_id, is_folder, name, mime_type, size_bytes, storage_path)
		 VALUES ($1, $2::uuid, $3::uuid, false, $4, $5, 0, $6)
		 RETURNING id::text, name`,
		newID, fileOwner, parentParam, req.Name, mime, storagePath,
	).Scan(&result.ID, &result.Name)
	if err != nil {
		_ = h.svc.storage.Delete(newID.String())
		httputil.RespondError(w, http.StatusInternalServerError, fmt.Sprintf("db insert: %v", err))
		return
	}

	httputil.Respond(w, http.StatusCreated, result)
}

// PublicCreateTextFile handles POST /api/v1/public/files/create-text?share_token=…
// Creates a new empty text file inside a shared folder via public share link.
func (h *Handler) PublicCreateTextFile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	shareToken := r.URL.Query().Get("share_token")
	if shareToken == "" {
		httputil.RespondError(w, http.StatusUnauthorized, "missing share_token")
		return
	}

	var req struct {
		Name     string `json:"name"`
		ParentID string `json:"parent_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		httputil.RespondError(w, http.StatusBadRequest, "name is required")
		return
	}

	ext := textFileExt(req.Name)
	if !textEditorExtensions[ext] {
		httputil.RespondError(w, http.StatusBadRequest, "file type not supported")
		return
	}

	mime := "text/plain"
	switch ext {
	case "json", "jsonc":
		mime = "application/json"
	case "html", "htm":
		mime = "text/html"
	case "xml":
		mime = "application/xml"
	case "md", "markdown":
		mime = "text/markdown"
	}

	var ownerID string
	var canEdit bool
	err := h.svc.db.QueryRow(ctx, `
		SELECT s.owner_id::text, s.can_edit
		  FROM shares s
		  JOIN files f ON f.id = s.resource_id
		 WHERE s.token = $1
		   AND s.revoked_at IS NULL
		   AND (s.expires_at IS NULL OR s.expires_at > now())
		   AND f.deleted_at IS NULL
		   AND f.is_folder = true
		   AND EXISTS (
		     WITH RECURSIVE anc AS (
		       SELECT id, parent_id FROM files
		        WHERE id = $2::uuid AND deleted_at IS NULL
		       UNION ALL
		       SELECT fi.id, fi.parent_id FROM files fi
		       JOIN anc ON fi.id = anc.parent_id
		        WHERE fi.deleted_at IS NULL
		     )
		     SELECT 1 FROM anc WHERE id = s.resource_id
		   )`,
		shareToken, req.ParentID,
	).Scan(&ownerID, &canEdit)
	if err != nil || !canEdit {
		httputil.RespondError(w, http.StatusForbidden, "no edit access via this share")
		return
	}

	newID := uuid.New()
	storagePath := h.svc.storage.Path(newID.String())

	if _, err := h.svc.storage.Write(newID.String(), strings.NewReader("")); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "storage write failed")
		return
	}

	type createResult struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	var result createResult
	err = h.svc.db.QueryRow(ctx,
		`INSERT INTO files (id, owner_id, parent_id, is_folder, name, mime_type, size_bytes, storage_path)
		 VALUES ($1, $2::uuid, $3::uuid, false, $4, $5, 0, $6)
		 RETURNING id::text, name`,
		newID, ownerID, req.ParentID, req.Name, mime, storagePath,
	).Scan(&result.ID, &result.Name)
	if err != nil {
		_ = h.svc.storage.Delete(newID.String())
		httputil.RespondError(w, http.StatusInternalServerError, "db insert failed")
		return
	}

	httputil.Respond(w, http.StatusCreated, result)
}

// ── Text-file content save ────────────────────────────────────────────────────

// textEditorExtensions is the set of file extensions allowed for the text editor.
var textEditorExtensions = map[string]bool{
	"txt": true, "md": true, "markdown": true, "json": true, "jsonc": true,
	"js": true, "jsx": true, "ts": true, "tsx": true, "css": true, "scss": true, "less": true,
	"html": true, "htm": true, "xml": true, "yml": true, "yaml": true,
	"ini": true, "toml": true, "conf": true, "config": true, "env": true,
	"properties": true, "log": true, "sql": true,
	"sh": true, "bash": true, "zsh": true,
	"py": true, "php": true, "java": true, "c": true, "cpp": true,
	"h": true, "hpp": true, "cs": true, "go": true, "rs": true,
	"rb": true, "pl": true, "lua": true,
	"dockerfile": true, "gitignore": true,
}

// textFileExt extracts the lowercase extension for text-editor checks.
// Handles special names like "Dockerfile" and ".gitignore".
func textFileExt(name string) string {
	lower := strings.ToLower(name)
	if lower == "dockerfile" {
		return "dockerfile"
	}
	if lower == ".gitignore" || lower == "gitignore" {
		return "gitignore"
	}
	dot := strings.LastIndex(lower, ".")
	if dot < 0 || dot == len(lower)-1 {
		return ""
	}
	return lower[dot+1:]
}

const textEditorMaxSaveBytes = 20 * 1024 * 1024 // 20 MB

// SaveContent handles PUT /api/v1/files/{id}/content — replaces file content
// from the request body. Only allowed for text-editor-compatible file types.
// Requires either file ownership or an active share with can_edit=true.
func (h *Handler) SaveContent(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")
	ctx := r.Context()

	// Limit request body to prevent abuse.
	r.Body = http.MaxBytesReader(w, r.Body, textEditorMaxSaveBytes)

	f, err := h.svc.GetAccessible(ctx, id, actor.ID.String())
	if err != nil || f == nil || f.IsFolder {
		httputil.RespondError(w, http.StatusNotFound, "file not found")
		return
	}

	// Verify the file is a text-editor-compatible type.
	ext := textFileExt(f.Name)
	if !textEditorExtensions[ext] {
		httputil.RespondError(w, http.StatusBadRequest, "file type not supported for text editing")
		return
	}

	// Permission check: owner OR has share with can_edit.
	if f.OwnerID.String() != actor.ID.String() {
		var canEdit bool
		err = h.svc.db.QueryRow(ctx,
			`WITH RECURSIVE anc AS (
			   SELECT id, parent_id FROM files WHERE id = $1::uuid AND deleted_at IS NULL
			   UNION ALL
			   SELECT p.id, p.parent_id FROM files p JOIN anc a ON p.id = a.parent_id WHERE p.deleted_at IS NULL
			 )
			 SELECT EXISTS (
			   SELECT 1 FROM shares s JOIN anc a ON a.id = s.resource_id
			   WHERE s.revoked_at IS NULL
			     AND (s.expires_at IS NULL OR s.expires_at > now())
			     AND s.can_edit = true
			     AND (
			       (s.grantee_type = 'user' AND s.grantee_id = $2::uuid)
			       OR (s.grantee_type = 'group' AND s.grantee_id IN (
			         SELECT group_id FROM group_members WHERE user_id = $2::uuid
			       ))
			     )
			 )`, id, actor.ID.String(),
		).Scan(&canEdit)
		if err != nil || !canEdit {
			httputil.RespondError(w, http.StatusForbidden, "write access denied")
			return
		}
	}

	if err := h.svc.ReplaceContent(ctx, id, r.Body); err != nil {
		log.Error().Err(err).Str("file_id", id).Msg("files.SaveContent")
		httputil.RespondError(w, http.StatusInternalServerError, "save failed")
		return
	}

	// Re-fetch updated file to return updated_at for conflict detection.
	updated, _ := h.svc.GetAccessible(ctx, id, actor.ID.String())
	if updated != nil {
		httputil.Respond(w, http.StatusOK, updated)
	} else {
		httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
	}
}
