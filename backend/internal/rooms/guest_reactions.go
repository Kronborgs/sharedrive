package rooms

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/ratelimit"
)

type guestReactionRequest struct {
	Emoji string `json:"emoji"`
}

func (handler *Handler) guestReactionAccess(w http.ResponseWriter, request *http.Request) (roomGuestAccess, uuid.UUID, bool) {
	if !handler.validGuestOrigin(request) {
		httputil.RespondError(w, http.StatusForbidden, "request origin is not allowed")
		return roomGuestAccess{}, uuid.Nil, false
	}
	_, messageID, ok := roomMessageParams(w, request)
	if !ok {
		return roomGuestAccess{}, uuid.Nil, false
	}
	access, ok := handler.guestAccess(w, request)
	if !ok {
		return roomGuestAccess{}, uuid.Nil, false
	}
	if !access.CanChat {
		httputil.RespondError(w, http.StatusForbidden, "guest reactions are not allowed")
		return roomGuestAccess{}, uuid.Nil, false
	}
	if !handler.allowRoomAction(request.Context(), ratelimit.KeyGuestRoomMutation, access.SessionID.String()+":reaction", 60, time.Minute) {
		httputil.RespondError(w, http.StatusTooManyRequests, "guest reaction rate limit exceeded")
		return roomGuestAccess{}, uuid.Nil, false
	}
	return access, messageID, true
}

func (handler *Handler) GuestAddReaction(w http.ResponseWriter, request *http.Request) {
	access, messageID, ok := handler.guestReactionAccess(w, request)
	if !ok {
		return
	}
	var input guestReactionRequest
	if !decodeRequest(w, request, &input) {
		return
	}
	if err := handler.service.addGuestReaction(request.Context(), access, messageID, input.Emoji); err != nil {
		handler.respondError(w, err)
		return
	}
	handler.publish(request.Context(), access.RoomID)
	httputil.Respond(w, http.StatusCreated, map[string]bool{"ok": true})
}

func (handler *Handler) GuestRemoveReaction(w http.ResponseWriter, request *http.Request) {
	access, messageID, ok := handler.guestReactionAccess(w, request)
	if !ok {
		return
	}
	if err := handler.service.removeGuestReaction(request.Context(), access, messageID, request.URL.Query().Get("emoji")); err != nil {
		handler.respondError(w, err)
		return
	}
	handler.publish(request.Context(), access.RoomID)
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (service *Service) addGuestReaction(ctx context.Context, access roomGuestAccess, messageID uuid.UUID, rawEmoji string) error {
	emoji, err := normalizeEmoji(rawEmoji)
	if err != nil {
		return err
	}
	var messageExists bool
	if err := service.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM room_messages WHERE id=$1 AND room_id=$2 AND deleted_at IS NULL)`, messageID, access.RoomID).Scan(&messageExists); err != nil {
		return err
	}
	if !messageExists {
		return ErrNotFound
	}
	_, err = service.db.Exec(ctx, `INSERT INTO room_reactions(message_id,guest_session_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, messageID, access.SessionID, emoji)
	return err
}

func (service *Service) removeGuestReaction(ctx context.Context, access roomGuestAccess, messageID uuid.UUID, rawEmoji string) error {
	emoji, err := normalizeEmoji(rawEmoji)
	if err != nil {
		return err
	}
	_, err = service.db.Exec(ctx, `DELETE FROM room_reactions reaction USING room_messages message
		WHERE reaction.message_id=message.id AND reaction.message_id=$1 AND reaction.guest_session_id=$2
		AND reaction.emoji=$3 AND message.room_id=$4`, messageID, access.SessionID, emoji, access.RoomID)
	return err
}
