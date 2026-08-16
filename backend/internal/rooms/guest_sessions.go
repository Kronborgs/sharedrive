package rooms

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

type RoomGuestSession struct {
	ID             uuid.UUID  `json:"id"`
	InviteID       uuid.UUID  `json:"invite_id"`
	DisplayName    string     `json:"display_name"`
	ExpiresAt      time.Time  `json:"expires_at"`
	LastAccessedAt *time.Time `json:"last_accessed_at,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
}

func (handler *Handler) ListGuestSessions(w http.ResponseWriter, request *http.Request) {
	roomID, _, ok := handler.managedRoom(w, request)
	if !ok {
		return
	}
	rows, err := handler.service.db.Query(request.Context(), `SELECT session.id, session.invite_id,
		session.display_name, session.expires_at, session.last_accessed_at, session.created_at
		FROM room_guest_sessions session
		JOIN room_invites invite ON invite.id = session.invite_id
		WHERE invite.room_id = $1 AND session.revoked_at IS NULL AND session.expires_at > now()
			AND invite.revoked_at IS NULL AND invite.expires_at > now()
		ORDER BY COALESCE(session.last_accessed_at, session.created_at) DESC LIMIT 200`, roomID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	defer rows.Close()
	sessions := make([]RoomGuestSession, 0)
	for rows.Next() {
		var session RoomGuestSession
		if err := rows.Scan(&session.ID, &session.InviteID, &session.DisplayName, &session.ExpiresAt,
			&session.LastAccessedAt, &session.CreatedAt); err != nil {
			handler.respondError(w, err)
			return
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, sessions)
}

func (handler *Handler) RevokeGuestSession(w http.ResponseWriter, request *http.Request) {
	roomID, room, ok := handler.managedRoom(w, request)
	if !ok {
		return
	}
	sessionID, err := uuid.Parse(chi.URLParam(request, "sessionID"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid guest session id")
		return
	}
	tag, err := handler.service.db.Exec(request.Context(), `UPDATE room_guest_sessions session SET revoked_at = now()
		FROM room_invites invite WHERE session.id = $1 AND session.invite_id = invite.id
			AND invite.room_id = $2 AND session.revoked_at IS NULL`, sessionID, roomID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		handler.respondError(w, ErrNotFound)
		return
	}
	actor := middleware.UserFromContext(request.Context())
	handler.service.log(request.Context(), audit.EventRoomGuestSessionRevoked, actor.ID, room, nil,
		map[string]any{"guest_session_id": sessionID})
	handler.publishRoomEvent(request.Context(), roomID, roomEvent{
		Type: "guest_session_revoked", GuestSessionID: sessionID.String(),
	})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (handler *Handler) managedRoom(w http.ResponseWriter, request *http.Request) (uuid.UUID, Room, bool) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return uuid.Nil, Room{}, false
	}
	actor := middleware.UserFromContext(request.Context())
	room, err := handler.service.Get(request.Context(), actor.ID, roomID)
	if err != nil {
		handler.respondError(w, err)
		return uuid.Nil, Room{}, false
	}
	if room.CurrentRole != RoleOwner && room.CurrentRole != RoleModerator {
		handler.respondError(w, ErrForbidden)
		return uuid.Nil, Room{}, false
	}
	return roomID, room, true
}
