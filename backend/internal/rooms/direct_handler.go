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

type createDirectConversationRequest struct {
	UserID uuid.UUID `json:"user_id"`
	RoomID uuid.UUID `json:"room_id"`
}

type addDirectResourceRequest struct {
	FileID    uuid.UUID  `json:"file_id"`
	MessageID *uuid.UUID `json:"message_id,omitempty"`
}

func directConversationID(w http.ResponseWriter, request *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(request, "conversationID"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid direct conversation id")
		return uuid.Nil, false
	}
	return id, true
}

func (handler *Handler) ListDirectConversations(w http.ResponseWriter, request *http.Request) {
	user := middleware.UserFromContext(request.Context())
	items, err := handler.service.ListDirectConversations(request.Context(), user.ID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, items)
}

func (handler *Handler) CreateDirectConversation(w http.ResponseWriter, request *http.Request) {
	var input createDirectConversationRequest
	if !decodeRequest(w, request, &input) || input.UserID == uuid.Nil || input.RoomID == uuid.Nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid direct conversation request")
		return
	}
	user := middleware.UserFromContext(request.Context())
	conversation, err := handler.service.CreateDirectConversation(request.Context(), user.ID, input.RoomID, input.UserID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusCreated, conversation)
}

func (handler *Handler) ListDirectMessages(w http.ResponseWriter, request *http.Request) {
	conversationID, ok := directConversationID(w, request)
	if !ok {
		return
	}
	limit, err := strconv.Atoi(request.URL.Query().Get("limit"))
	if err != nil && request.URL.Query().Has("limit") {
		httputil.RespondError(w, http.StatusBadRequest, "invalid message limit")
		return
	}
	var cursor *uuid.UUID
	if raw := request.URL.Query().Get("cursor"); raw != "" {
		parsed, parseErr := uuid.Parse(raw)
		if parseErr != nil {
			httputil.RespondError(w, http.StatusBadRequest, "invalid message cursor")
			return
		}
		cursor = &parsed
	}
	user := middleware.UserFromContext(request.Context())
	page, err := handler.service.ListDirectMessages(request.Context(), user.ID, conversationID, limit, cursor)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, page)
}

func (handler *Handler) CreateDirectMessage(w http.ResponseWriter, request *http.Request) {
	conversationID, ok := directConversationID(w, request)
	if !ok {
		return
	}
	var input createMessageRequest
	if !decodeRequest(w, request, &input) {
		return
	}
	user := middleware.UserFromContext(request.Context())
	allowed, _, _, limitErr := handler.limiter.Allow(request.Context(), ratelimit.KeyUserRoomMessage, user.ID.String(), 30, time.Minute)
	if limitErr != nil || !allowed {
		httputil.RespondError(w, http.StatusTooManyRequests, "direct message rate limit exceeded")
		return
	}
	message, err := handler.service.CreateDirectMessage(request.Context(), user.ID, conversationID, input.Body, input.ReplyTo)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusCreated, message)
}

func (handler *Handler) MarkDirectConversationRead(w http.ResponseWriter, request *http.Request) {
	conversationID, ok := directConversationID(w, request)
	if !ok {
		return
	}
	user := middleware.UserFromContext(request.Context())
	if err := handler.service.MarkDirectConversationRead(request.Context(), user.ID, conversationID); err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusNoContent, nil)
}

func (handler *Handler) CreateDirectMediaToken(w http.ResponseWriter, request *http.Request) {
	if !handler.voiceEnabled(w, request) {
		return
	}
	if handler.liveKitURL == "" || handler.liveKitKey == "" || handler.liveKitSecret == "" {
		httputil.RespondError(w, http.StatusServiceUnavailable, "voice is not configured")
		return
	}
	conversationID, ok := directConversationID(w, request)
	if !ok {
		return
	}
	mode, ok := mediaModeFromRequest(w, request)
	if !ok {
		return
	}
	user := middleware.UserFromContext(request.Context())
	if _, err := handler.service.directConversationForActor(request.Context(), user.ID, conversationID); err != nil {
		handler.respondError(w, err)
		return
	}
	if !handler.liveKitAvailable(request.Context()) {
		httputil.RespondError(w, http.StatusServiceUnavailable, voiceUnavailableMessage)
		return
	}
	mediaRoom := handler.directMediaRoomName(conversationID)
	signed, err := handler.mediaTokenForRoom(mediaRoom, "user:"+user.ID.String(), user.DisplayName, true, mode)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, internalErrorMessage)
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]string{"url": handler.liveKitURL, "token": signed, "room": mediaRoom})
}

func (handler *Handler) ListDirectResources(w http.ResponseWriter, request *http.Request) {
	conversationID, ok := directConversationID(w, request)
	if !ok {
		return
	}
	user := middleware.UserFromContext(request.Context())
	resources, err := handler.service.ListDirectResources(request.Context(), user.ID, conversationID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, resources)
}

func (handler *Handler) AddDirectResource(w http.ResponseWriter, request *http.Request) {
	conversationID, ok := directConversationID(w, request)
	if !ok {
		return
	}
	var input addDirectResourceRequest
	if !decodeRequest(w, request, &input) || input.FileID == uuid.Nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid direct file resource")
		return
	}
	user := middleware.UserFromContext(request.Context())
	resource, err := handler.service.AddDirectFileResource(request.Context(), user.ID, conversationID, input.FileID, input.MessageID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusCreated, resource)
}
