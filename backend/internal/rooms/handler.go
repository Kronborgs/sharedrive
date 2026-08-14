package rooms

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

type Handler struct {
	service *Service
}

func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

type createRoomRequest struct {
	Name string `json:"name"`
}

type updateRoomRequest struct {
	Name *string `json:"name"`
}

type addMemberRequest struct {
	UserID uuid.UUID `json:"user_id"`
	Email  string    `json:"email"`
	Role   string    `json:"role"`
}

func (handler *Handler) List(w http.ResponseWriter, request *http.Request) {
	user := middleware.UserFromContext(request.Context())
	includeArchived, err := strconv.ParseBool(request.URL.Query().Get("include_archived"))
	if err != nil && request.URL.Query().Has("include_archived") {
		httputil.RespondError(w, http.StatusBadRequest, "invalid include_archived filter")
		return
	}
	result, err := handler.service.List(request.Context(), user.ID, includeArchived)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, result)
}

func (handler *Handler) Create(w http.ResponseWriter, request *http.Request) {
	var input createRoomRequest
	if !decodeRequest(w, request, &input) {
		return
	}
	user := middleware.UserFromContext(request.Context())
	if user.Role == "guest" {
		httputil.RespondError(w, http.StatusForbidden, "guests cannot create rooms")
		return
	}
	room, err := handler.service.Create(request.Context(), user.ID, input.Name)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusCreated, room)
}

func (handler *Handler) Get(w http.ResponseWriter, request *http.Request) {
	user := middleware.UserFromContext(request.Context())
	roomReference := chi.URLParam(request, "roomID")
	roomID, parseErr := uuid.Parse(roomReference)
	var room Room
	var err error
	if parseErr == nil {
		room, err = handler.service.Get(request.Context(), user.ID, roomID)
	} else {
		room, err = handler.service.GetBySlug(request.Context(), user.ID, roomReference)
	}
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, room)
}

func (handler *Handler) Update(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return
	}
	var input updateRoomRequest
	if !decodeRequest(w, request, &input) {
		return
	}
	if input.Name == nil {
		httputil.RespondError(w, http.StatusBadRequest, "name is required")
		return
	}
	user := middleware.UserFromContext(request.Context())
	room, err := handler.service.UpdateName(request.Context(), user.ID, roomID, *input.Name)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, room)
}

func (handler *Handler) Archive(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return
	}
	user := middleware.UserFromContext(request.Context())
	room, err := handler.service.Archive(request.Context(), user.ID, roomID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, room)
}

func (handler *Handler) ListMembers(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return
	}
	user := middleware.UserFromContext(request.Context())
	members, err := handler.service.ListMembers(request.Context(), user.ID, roomID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, members)
}

func (handler *Handler) AddMember(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return
	}
	var input addMemberRequest
	if !decodeRequest(w, request, &input) {
		return
	}
	user := middleware.UserFromContext(request.Context())
	var err error
	if input.UserID != uuid.Nil {
		err = handler.service.AddMember(request.Context(), user.ID, roomID, input.UserID, input.Role)
	} else {
		err = handler.service.AddMemberByEmail(request.Context(), user.ID, roomID, input.Email, input.Role)
	}
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusCreated, map[string]bool{"ok": true})
}

func (handler *Handler) RemoveMember(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return
	}
	userID, err := uuid.Parse(chi.URLParam(request, "userID"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	user := middleware.UserFromContext(request.Context())
	if err := handler.service.RemoveMember(request.Context(), user.ID, roomID, userID); err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func roomIDParam(w http.ResponseWriter, request *http.Request) (uuid.UUID, bool) {
	roomID, err := uuid.Parse(chi.URLParam(request, "roomID"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid room id")
		return uuid.Nil, false
	}
	return roomID, true
}

func decodeRequest(w http.ResponseWriter, request *http.Request, target any) bool {
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return false
	}
	return true
}

func (handler *Handler) respondError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	message := "internal error"
	switch {
	case errors.Is(err, ErrInvalidName), errors.Is(err, ErrInvalidRole):
		status, message = http.StatusBadRequest, err.Error()
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrMemberNotFound):
		status, message = http.StatusNotFound, err.Error()
	case errors.Is(err, ErrForbidden), errors.Is(err, ErrOwnerRemoval):
		status, message = http.StatusForbidden, err.Error()
	case errors.Is(err, ErrArchived), errors.Is(err, ErrMemberExists):
		status, message = http.StatusConflict, err.Error()
	}
	httputil.RespondError(w, status, message)
}
