package rooms

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
	"github.com/yourname/privatedrive/internal/ratelimit"
)

type importRemoteGIFRequest struct {
	URL string `json:"url"`
}
type gifLibraryRequest struct {
	FileID      uuid.UUID `json:"file_id"`
	Title       string    `json:"title"`
	SearchTerms string    `json:"search_terms"`
	Category    string    `json:"category"`
}

func (handler *Handler) ListGIFLibrary(w http.ResponseWriter, request *http.Request) {
	user := middleware.UserFromContext(request.Context())
	allowed, _, _, limitErr := handler.limiter.Allow(request.Context(), ratelimit.KeyUserRoomGIFSearch, user.ID.String(), 60, time.Minute)
	if limitErr != nil || !allowed {
		httputil.RespondError(w, http.StatusTooManyRequests, "gif search rate limit exceeded")
		return
	}
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	items, err := handler.service.ListGIFLibrary(request.Context(), user.ID, request.URL.Query().Get("q"), limit)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]any{"items": items})
}

func (handler *Handler) ImportRemoteGIF(w http.ResponseWriter, request *http.Request) {
	var input importRemoteGIFRequest
	if !decodeRequest(w, request, &input) {
		return
	}
	user := middleware.UserFromContext(request.Context())
	allowed, _, _, limitErr := handler.limiter.Allow(request.Context(), ratelimit.KeyUserRoomGIFSearch, user.ID.String(), 20, time.Minute)
	if limitErr != nil || !allowed {
		httputil.RespondError(w, http.StatusTooManyRequests, "GIF import rate limit exceeded")
		return
	}
	item, err := handler.service.ImportRemoteGIF(request.Context(), user.ID, input.URL)
	if errors.Is(err, ErrInvalidRemoteGIFURL) || errors.Is(err, ErrInvalidRemoteGIF) {
		httputil.RespondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusCreated, item)
}
func (handler *Handler) AdminListGIFLibrary(w http.ResponseWriter, request *http.Request) {
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	items, err := handler.service.ListAllGIFLibrary(request.Context(), request.URL.Query().Get("q"), limit)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]any{"items": items})
}

func (handler *Handler) AdminAddGIFLibraryItem(w http.ResponseWriter, request *http.Request) {
	var input gifLibraryRequest
	if !decodeRequest(w, request, &input) || input.FileID == uuid.Nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid gif library item")
		return
	}
	user := middleware.UserFromContext(request.Context())
	item, err := handler.service.AddGIFLibraryItem(request.Context(), user.ID, input.FileID, input.Title, input.SearchTerms, input.Category)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusCreated, item)
}

func (handler *Handler) AdminDeleteGIFLibraryItem(w http.ResponseWriter, request *http.Request) {
	id, err := uuid.Parse(chi.URLParam(request, "gifID"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid gif id")
		return
	}
	if err := handler.service.RemoveGIFLibraryItem(request.Context(), id); err != nil {
		handler.respondError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *Handler) PreviewGIF(w http.ResponseWriter, request *http.Request) {
	fileID := chi.URLParam(request, "fileID")
	if _, err := uuid.Parse(fileID); err != nil {
		httputil.RespondError(w, http.StatusNotFound, "gif not found")
		return
	}
	file, reader, err := handler.service.fileSvc.OpenLibraryGIF(request.Context(), fileID)
	if err != nil {
		httputil.RespondError(w, http.StatusNotFound, "gif not found")
		return
	}
	defer reader.Close()
	w.Header().Set("Content-Type", file.MimeType)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeContent(w, request, file.Name, file.UpdatedAt, reader)
}

// SeedStarterGIFs imports the embedded global starter library once when empty.
func (handler *Handler) SeedStarterGIFs(ctx context.Context) error {
	return handler.service.SeedStarterGIFs(ctx)
}
