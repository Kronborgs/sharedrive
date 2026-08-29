package rooms

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
	"github.com/yourname/privatedrive/internal/ratelimit"
)

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
