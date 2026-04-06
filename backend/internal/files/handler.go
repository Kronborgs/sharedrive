package files

import (
	"archive/zip"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

// Handler provides HTTP handlers for the files API.
type Handler struct {
	svc      *Service
	trash    *TrashService
	auditSvc audit.Logger
}

// NewHandler creates a Handler.
func NewHandler(svc *Service, trash *TrashService, auditSvc audit.Logger) *Handler {
	return &Handler{svc: svc, trash: trash, auditSvc: auditSvc}
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
	h.auditSvc.Log(ctx, audit.Event{
		Type:         audit.EventFolderCreated,
		ActorID:      &actor.ID,
		ResourceID:   &f.ID,
		ResourceName: f.Name,
		IPAddress:    middleware.ClientIP(r),
	})
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

// Delete handles DELETE /api/v1/files/{id} — soft-delete (moves to trash).
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	id := chi.URLParam(r, "id")
	ctx := r.Context()

	if err := h.trash.SoftDelete(ctx, id, actor.ID.String()); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, err.Error())
		return
	}
	h.auditSvc.Log(ctx, audit.Event{
		Type:      audit.EventFileDeleted,
		ActorID:   &actor.ID,
		IPAddress: middleware.ClientIP(r),
		Metadata:  map[string]any{"file_id": id},
	})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// Download handles GET /api/v1/files/{id}/download — streams file bytes.
func (h *Handler) Download(w http.ResponseWriter, r *http.Request) {
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
	w.Header().Set("Content-Disposition", `attachment; filename="`+f.Name+`"`)
	http.ServeContent(w, r, f.Name, f.UpdatedAt, reader)

	h.auditSvc.Log(ctx, audit.Event{
		Type:         audit.EventFileDownloaded,
		ActorID:      &actor.ID,
		ResourceID:   &f.ID,
		ResourceName: f.Name,
		IPAddress:    middleware.ClientIP(r),
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

	if err := h.trash.PermanentDelete(ctx, id, actor.ID.String()); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, err.Error())
		return
	}
	h.auditSvc.Log(ctx, audit.Event{
		Type:      audit.EventFilePermanentDeleted,
		ActorID:   &actor.ID,
		IPAddress: middleware.ClientIP(r),
		Metadata:  map[string]any{"file_id": id},
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

	// Enforce max upload size before reading body
	maxBytes := h.svc.GetEffectiveMaxUpload(r.Context(), actor.ID.String(), actor.Role, r.FormValue("folder_id"))
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+1024) // +1 KB for form overhead

	if err := r.ParseMultipartForm(32 << 20); err != nil {
		httputil.RespondError(w, http.StatusRequestEntityTooLarge, "file exceeds the maximum upload size for this account")
		return
	}

	fileData, header, err := r.FormFile("file")
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "file is required")
		return
	}
	defer fileData.Close()

	folderID := r.FormValue("folder_id")
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

	h.auditSvc.Log(r.Context(), audit.Event{
		Type:         audit.EventFileUploaded,
		ActorID:      &actor.ID,
		ResourceID:   &f.ID,
		ResourceName: f.Name,
		IPAddress:    middleware.ClientIP(r),
	})
	httputil.Respond(w, http.StatusCreated, f)
}

// DownloadZip handles GET /api/v1/files/download-zip?ids=id1,id2,...
// Streams a zip archive of the requested files the actor can access.
func (h *Handler) DownloadZip(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	ctx := r.Context()

	rawIDs := r.URL.Query().Get("ids")
	if rawIDs == "" {
		httputil.RespondError(w, http.StatusBadRequest, "ids is required")
		return
	}

	ids := strings.Split(rawIDs, ",")
	if len(ids) > 100 {
		httputil.RespondError(w, http.StatusBadRequest, "too many ids (max 100)")
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="download.zip"`)

	zw := zip.NewWriter(w)
	defer zw.Close()

	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if _, err := uuid.Parse(id); err != nil {
			continue
		}
		f, err := h.svc.GetAccessible(ctx, id, actor.ID.String())
		if err != nil || f == nil || f.IsFolder {
			continue
		}
		reader, err := h.svc.storage.Open(id)
		if err != nil {
			log.Warn().Err(err).Str("file_id", id).Msg("DownloadZip: open storage")
			continue
		}
		fw, zerr := zw.Create(f.Name)
		if zerr != nil {
			reader.Close()
			log.Warn().Err(zerr).Str("file_id", id).Msg("DownloadZip: create zip entry")
			continue
		}
		buf := make([]byte, 32*1024)
		for {
			n, rerr := reader.Read(buf)
			if n > 0 {
				if _, werr := fw.Write(buf[:n]); werr != nil {
					break
				}
			}
			if rerr != nil {
				break
			}
		}
		reader.Close()
	}
}
