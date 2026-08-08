package notes

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

type Handler struct {
	service *Service
	sharing *SharingService
}

func NewHandler(service *Service, sharing *SharingService) *Handler {
	return &Handler{service: service, sharing: sharing}
}

func (handler *Handler) List(w http.ResponseWriter, request *http.Request) {
	user := middleware.UserFromContext(request.Context())
	options := ListOptions{
		Search:   request.URL.Query().Get("search"),
		Type:     request.URL.Query().Get("type"),
		Archived: queryBool(request, "archived"),
		Deleted:  queryBool(request, "deleted"),
		Limit:    queryInt(request, "limit", 50),
		Offset:   queryInt(request, "offset", 0),
	}
	if rawPinned := request.URL.Query().Get("pinned"); rawPinned != "" {
		pinned, err := strconv.ParseBool(rawPinned)
		if err != nil {
			httputil.RespondError(w, http.StatusBadRequest, "invalid pinned filter")
			return
		}
		options.Pinned = &pinned
	}
	notes, err := handler.service.List(request.Context(), user.ID, options)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, notes)
}

func (handler *Handler) Create(w http.ResponseWriter, request *http.Request) {
	var input CreateInput
	if !decodeJSON(w, request, &input) {
		return
	}
	user := middleware.UserFromContext(request.Context())
	note, err := handler.service.Create(authenticatedEditorContext(request), user.ID, input)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusCreated, note)
}

func (handler *Handler) Get(w http.ResponseWriter, request *http.Request) {
	user := middleware.UserFromContext(request.Context())
	noteID, ok := noteIDParam(w, request)
	if !ok {
		return
	}
	note, err := handler.service.Get(request.Context(), user.ID, noteID, queryBool(request, "include_deleted"))
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, note)
}

func (handler *Handler) Update(w http.ResponseWriter, request *http.Request) {
	var input UpdateInput
	if !decodeJSON(w, request, &input) {
		return
	}
	handler.withNote(w, request, func(ownerID, noteID uuid.UUID) (Note, error) {
		return handler.service.Update(authenticatedEditorContext(request), ownerID, noteID, input)
	})
}

func (handler *Handler) ConvertToChecklist(w http.ResponseWriter, request *http.Request) {
	handler.withNote(w, request, func(ownerID, noteID uuid.UUID) (Note, error) {
		return handler.service.ConvertToChecklist(authenticatedEditorContext(request), ownerID, noteID)
	})
}

func (handler *Handler) Delete(w http.ResponseWriter, request *http.Request) {
	handler.withEmpty(w, request, handler.service.SoftDelete)
}

func (handler *Handler) Restore(w http.ResponseWriter, request *http.Request) {
	handler.withEmpty(w, request, handler.service.Restore)
}

func (handler *Handler) PermanentDelete(w http.ResponseWriter, request *http.Request) {
	handler.withEmpty(w, request, handler.service.PermanentDelete)
}

func (handler *Handler) CreateItem(w http.ResponseWriter, request *http.Request) {
	var input ItemInput
	if !decodeJSON(w, request, &input) {
		return
	}
	handler.withNote(w, request, func(ownerID, noteID uuid.UUID) (Note, error) {
		return handler.service.CreateItem(authenticatedEditorContext(request), ownerID, noteID, input)
	})
}

func (handler *Handler) UpdateItem(w http.ResponseWriter, request *http.Request) {
	var input ItemInput
	if !decodeJSON(w, request, &input) {
		return
	}
	itemID, err := uuid.Parse(chi.URLParam(request, "itemId"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid item id")
		return
	}
	handler.withNote(w, request, func(ownerID, noteID uuid.UUID) (Note, error) {
		return handler.service.UpdateItem(authenticatedEditorContext(request), ownerID, noteID, itemID, input)
	})
}

func (handler *Handler) DeleteItem(w http.ResponseWriter, request *http.Request) {
	itemID, err := uuid.Parse(chi.URLParam(request, "itemId"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid item id")
		return
	}
	version := queryInt(request, "version", 0)
	handler.withNote(w, request, func(ownerID, noteID uuid.UUID) (Note, error) {
		return handler.service.DeleteItem(authenticatedEditorContext(request), ownerID, noteID, itemID, int64(version))
	})
}

func (handler *Handler) ReorderItems(w http.ResponseWriter, request *http.Request) {
	var input ReorderInput
	if !decodeJSON(w, request, &input) {
		return
	}
	handler.withNote(w, request, func(ownerID, noteID uuid.UUID) (Note, error) {
		return handler.service.ReorderItems(authenticatedEditorContext(request), ownerID, noteID, input)
	})
}

func authenticatedEditorContext(request *http.Request) context.Context {
	user := middleware.UserFromContext(request.Context())
	if user == nil {
		return request.Context()
	}
	label := user.DisplayName
	if label == "" {
		label = user.Email
	}
	return withEditor(request.Context(), label)
}

func (handler *Handler) withNote(w http.ResponseWriter, request *http.Request, action func(uuid.UUID, uuid.UUID) (Note, error)) {
	noteID, ok := noteIDParam(w, request)
	if !ok {
		return
	}
	user := middleware.UserFromContext(request.Context())
	note, err := action(user.ID, noteID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, note)
}

func (handler *Handler) withEmpty(w http.ResponseWriter, request *http.Request, action func(context.Context, uuid.UUID, uuid.UUID) error) {
	noteID, ok := noteIDParam(w, request)
	if !ok {
		return
	}
	user := middleware.UserFromContext(request.Context())
	if err := action(request.Context(), user.ID, noteID); err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (handler *Handler) respondError(w http.ResponseWriter, err error) {
	status, message := PublicError(err)
	if status == http.StatusInternalServerError {
		log.Error().Err(err).Msg("notes request failed")
	}
	httputil.RespondError(w, status, message)
}

func noteIDParam(w http.ResponseWriter, request *http.Request) (uuid.UUID, bool) {
	noteID, err := uuid.Parse(chi.URLParam(request, "id"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid note id")
		return uuid.Nil, false
	}
	return noteID, true
}

func decodeJSON(w http.ResponseWriter, request *http.Request, target any) bool {
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return false
	}
	return true
}

func queryBool(request *http.Request, key string) bool {
	value, _ := strconv.ParseBool(request.URL.Query().Get(key))
	return value
}

func queryInt(request *http.Request, key string, fallback int) int {
	value, err := strconv.Atoi(request.URL.Query().Get(key))
	if err != nil {
		return fallback
	}
	return value
}
