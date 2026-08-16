package rooms

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	goredis "github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
	"github.com/yourname/privatedrive/internal/ratelimit"
)

const internalErrorMessage = "internal error"

type RoomMailer interface {
	SendRoomInvitation(ctx context.Context, toEmail, inviterName, roomName, role, inviteLink string) error
}

type Handler struct {
	service      *Service
	hub          *roomHub
	limiter      *ratelimit.Limiter
	redis        *goredis.Client
	appURL       string
	secureCookie bool
	uploadTokens guestUploadTokenIssuer
	mailer       RoomMailer
}

func NewHandler(service *Service, limiter *ratelimit.Limiter, redisClient *goredis.Client, appURL string, secureCookie bool, uploadTokens guestUploadTokenIssuer, mailer RoomMailer) *Handler {
	return &Handler{service: service, hub: newRoomHub(), limiter: limiter, redis: redisClient, appURL: appURL, secureCookie: secureCookie, uploadTokens: uploadTokens, mailer: mailer}
}

type createRoomRequest struct {
	Name string `json:"name"`
}

type updateRoomRequest struct {
	Name *string `json:"name"`
}

type addResourceRequest struct {
	ResourceType ResourceType `json:"resource_type"`
	ResourceID   uuid.UUID    `json:"resource_id"`
}
type updateMessageRequest struct {
	Body string `json:"body"`
}
type reactionRequest struct {
	Emoji string `json:"emoji"`
}
type markReadRequest struct {
	MessageID uuid.UUID `json:"message_id"`
}
type createMessageRequest struct {
	Body    string     `json:"body"`
	ReplyTo *uuid.UUID `json:"reply_to_message_id"`
}
type addMemberRequest struct {
	UserID uuid.UUID `json:"user_id"`
	Email  string    `json:"email"`
	Role   string    `json:"role"`
}

func (handler *Handler) RequireEnabled(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		enabled, err := handler.service.Enabled(request.Context())
		if err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, internalErrorMessage)
			return
		}
		if !enabled {
			httputil.RespondError(w, http.StatusNotFound, "rooms are disabled")
			return
		}
		if currentUser := middleware.UserFromContext(request.Context()); currentUser != nil {
			allowed, accessErr := handler.service.UserAccessEnabled(request.Context(), currentUser.ID)
			if accessErr != nil {
				httputil.RespondError(w, http.StatusInternalServerError, internalErrorMessage)
				return
			}
			if !allowed {
				httputil.RespondError(w, http.StatusForbidden, "rooms access is disabled for this account")
				return
			}
		}
		next(w, request)
	}
}
func (handler *Handler) ListResources(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return
	}
	user := middleware.UserFromContext(request.Context())
	resources, err := handler.service.ListResources(request.Context(), user.ID, roomID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, resources)
}

func (handler *Handler) AddResource(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return
	}
	var input addResourceRequest
	if !decodeRequest(w, request, &input) {
		return
	}
	if input.ResourceID == uuid.Nil || !ValidResourceType(input.ResourceType) {
		httputil.RespondError(w, http.StatusBadRequest, "invalid room resource")
		return
	}
	user := middleware.UserFromContext(request.Context())
	resource, err := handler.service.AddResource(request.Context(), user.ID, roomID, input.ResourceType, input.ResourceID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	handler.publish(request.Context(), roomID)
	httputil.Respond(w, http.StatusCreated, resource)
}

func (handler *Handler) RemoveResource(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return
	}
	resourceID, err := uuid.Parse(chi.URLParam(request, "resourceID"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid resource id")
		return
	}
	user := middleware.UserFromContext(request.Context())
	if err := handler.service.RemoveResource(request.Context(), user.ID, roomID, resourceID); err != nil {
		handler.respondError(w, err)
		return
	}
	handler.publish(request.Context(), roomID)
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}
func (handler *Handler) UpdateMessage(w http.ResponseWriter, request *http.Request) {
	roomID, messageID, ok := roomMessageParams(w, request)
	if !ok {
		return
	}
	var input updateMessageRequest
	if !decodeRequest(w, request, &input) {
		return
	}
	user := middleware.UserFromContext(request.Context())
	message, err := handler.service.UpdateMessage(request.Context(), user.ID, roomID, messageID, input.Body)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	handler.publish(request.Context(), roomID)
	httputil.Respond(w, http.StatusOK, message)
}
func (handler *Handler) DeleteMessage(w http.ResponseWriter, request *http.Request) {
	roomID, messageID, ok := roomMessageParams(w, request)
	if !ok {
		return
	}
	user := middleware.UserFromContext(request.Context())
	if err := handler.service.DeleteMessage(request.Context(), user.ID, user.Role, roomID, messageID); err != nil {
		handler.respondError(w, err)
		return
	}
	handler.publish(request.Context(), roomID)
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}
func (handler *Handler) AddReaction(w http.ResponseWriter, request *http.Request) {
	roomID, messageID, ok := roomMessageParams(w, request)
	if !ok {
		return
	}
	var input reactionRequest
	if !decodeRequest(w, request, &input) {
		return
	}
	user := middleware.UserFromContext(request.Context())
	if err := handler.service.AddReaction(request.Context(), user.ID, roomID, messageID, input.Emoji); err != nil {
		handler.respondError(w, err)
		return
	}
	handler.publish(request.Context(), roomID)
	httputil.Respond(w, http.StatusCreated, map[string]bool{"ok": true})
}
func (handler *Handler) RemoveReaction(w http.ResponseWriter, request *http.Request) {
	roomID, messageID, ok := roomMessageParams(w, request)
	if !ok {
		return
	}
	user := middleware.UserFromContext(request.Context())
	if err := handler.service.RemoveReaction(request.Context(), user.ID, roomID, messageID, request.URL.Query().Get("emoji")); err != nil {
		handler.respondError(w, err)
		return
	}
	handler.publish(request.Context(), roomID)
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}
func (handler *Handler) MarkRead(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return
	}
	var input markReadRequest
	if !decodeRequest(w, request, &input) || input.MessageID == uuid.Nil {
		return
	}
	user := middleware.UserFromContext(request.Context())
	if err := handler.service.MarkRead(request.Context(), user.ID, roomID, input.MessageID); err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}
func roomMessageParams(w http.ResponseWriter, request *http.Request) (uuid.UUID, uuid.UUID, bool) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return uuid.Nil, uuid.Nil, false
	}
	messageID, err := uuid.Parse(chi.URLParam(request, "messageID"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid message id")
		return uuid.Nil, uuid.Nil, false
	}
	return roomID, messageID, true
}
func (handler *Handler) ListMessages(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return
	}
	limit, err := strconv.Atoi(request.URL.Query().Get("limit"))
	if err != nil && request.URL.Query().Has("limit") {
		httputil.RespondError(w, http.StatusBadRequest, "invalid message limit")
		return
	}
	var cursor *uuid.UUID
	if rawCursor := request.URL.Query().Get("cursor"); rawCursor != "" {
		parsedCursor, parseErr := uuid.Parse(rawCursor)
		if parseErr != nil {
			httputil.RespondError(w, http.StatusBadRequest, "invalid message cursor")
			return
		}
		cursor = &parsedCursor
	}
	user := middleware.UserFromContext(request.Context())
	page, err := handler.service.ListMessages(request.Context(), user.ID, roomID, limit, cursor)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, page)
}

func (handler *Handler) CreateMessage(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
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
		httputil.RespondError(w, http.StatusTooManyRequests, "room message rate limit exceeded")
		return
	}
	message, err := handler.service.CreateMessage(request.Context(), user.ID, roomID, input.Body, input.ReplyTo)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	handler.publish(request.Context(), roomID)
	httputil.Respond(w, http.StatusCreated, message)
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

type addMemberOutcome struct {
	recipientEmail string
	inviteLink     string
	pendingAccount bool
}

func (handler *Handler) addMemberOrInvite(ctx context.Context, actorID, roomID uuid.UUID, input addMemberRequest) (addMemberOutcome, error) {
	result := addMemberOutcome{recipientEmail: strings.TrimSpace(input.Email)}
	if input.UserID != uuid.Nil {
		if err := handler.service.AddMember(ctx, actorID, roomID, input.UserID, input.Role); err != nil {
			return result, err
		}
		email, err := handler.service.MemberEmail(ctx, input.UserID)
		result.recipientEmail = email
		return result, err
	}

	err := handler.service.AddMemberByEmail(ctx, actorID, roomID, result.recipientEmail, input.Role)
	if !errors.Is(err, ErrMemberNotFound) {
		return result, err
	}
	rawToken, err := handler.service.InviteMemberByEmail(ctx, actorID, roomID, result.recipientEmail, input.Role)
	if err != nil {
		return result, err
	}
	result.pendingAccount = true
	result.inviteLink = strings.TrimRight(handler.appURL, "/") + "/accept-invite?token=" + url.QueryEscape(rawToken)
	return result, nil
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
	actor := middleware.UserFromContext(request.Context())
	result, err := handler.addMemberOrInvite(request.Context(), actor.ID, roomID, input)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	room, err := handler.service.Get(request.Context(), actor.ID, roomID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	if result.inviteLink == "" {
		result.inviteLink = strings.TrimRight(handler.appURL, "/") + "/rooms/" + room.ID.String()
	}
	mailRole := input.Role
	if result.pendingAccount {
		mailRole = "room_" + input.Role
	}
	mailSent := handler.sendRoomInvitation(request.Context(), result.recipientEmail, actor.DisplayName, actor.Email, room, mailRole, result.inviteLink)
	response := map[string]any{"ok": true, "mail_sent": mailSent}
	if result.pendingAccount {
		response["invite_url"] = result.inviteLink
	}
	httputil.Respond(w, http.StatusCreated, response)
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

func (handler *Handler) sendRoomInvitation(ctx context.Context, toEmail, displayName, fallbackName string, room Room, role, inviteLink string) bool {
	if handler.mailer == nil || strings.TrimSpace(toEmail) == "" {
		return false
	}
	inviterName := strings.TrimSpace(displayName)
	if inviterName == "" {
		inviterName = fallbackName
	}
	if err := handler.mailer.SendRoomInvitation(ctx, toEmail, inviterName, room.Name, role, inviteLink); err != nil {
		log.Warn().Err(err).Str("room_id", room.ID.String()).Msg("rooms: invitation email failed")
		return false
	}
	return true
}

func (handler *Handler) respondError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	message := internalErrorMessage
	switch {
	case errors.Is(err, ErrInvalidName), errors.Is(err, ErrInvalidRole):
		status, message = http.StatusBadRequest, err.Error()
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrMemberNotFound):
		status, message = http.StatusNotFound, err.Error()
	case errors.Is(err, ErrForbidden), errors.Is(err, ErrOwnerRemoval):
		status, message = http.StatusForbidden, err.Error()
	case errors.Is(err, ErrArchived), errors.Is(err, ErrMemberExists), errors.Is(err, ErrResourceExists):
		status, message = http.StatusConflict, err.Error()
	case errors.Is(err, ErrEncryptionUnavailable):
		status, message = http.StatusServiceUnavailable, "rooms chat encryption is not configured"
	}
	httputil.RespondError(w, status, message)
}
