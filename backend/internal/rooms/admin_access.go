package rooms

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

type adminRoomAccount struct {
	ID            uuid.UUID `json:"id"`
	Email         string    `json:"email"`
	DisplayName   string    `json:"display_name"`
	AccountType   string    `json:"account_type"`
	AccessEnabled bool      `json:"access_enabled"`
	RoomCount     int       `json:"room_count"`
}

type adminPendingRoomUser struct {
	ID        uuid.UUID `json:"id"`
	Email     string    `json:"email"`
	RoomID    uuid.UUID `json:"room_id"`
	RoomName  string    `json:"room_name"`
	Role      string    `json:"role"`
	ExpiresAt time.Time `json:"expires_at"`
}

type adminRoomGuest struct {
	SessionID      uuid.UUID  `json:"session_id"`
	DisplayName    string     `json:"display_name"`
	Invitation     string     `json:"invitation"`
	RoomID         uuid.UUID  `json:"room_id"`
	RoomName       string     `json:"room_name"`
	ExpiresAt      time.Time  `json:"expires_at"`
	LastAccessedAt *time.Time `json:"last_accessed_at,omitempty"`
}

type adminRoomsOverview struct {
	Accounts           []adminRoomAccount     `json:"accounts"`
	PendingInvitations []adminPendingRoomUser `json:"pending_invitations"`
	Guests             []adminRoomGuest       `json:"guests"`
}

func (handler *Handler) AdminListAccess(w http.ResponseWriter, request *http.Request) {
	overview, err := handler.loadAdminRoomsOverview(request)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, overview)
}

func (handler *Handler) loadAdminRoomsOverview(request *http.Request) (adminRoomsOverview, error) {
	accounts, err := handler.loadAdminRoomAccounts(request)
	if err != nil {
		return adminRoomsOverview{}, err
	}
	pending, err := handler.loadAdminPendingRoomUsers(request)
	if err != nil {
		return adminRoomsOverview{}, err
	}
	guests, err := handler.loadAdminRoomGuests(request)
	return adminRoomsOverview{Accounts: accounts, PendingInvitations: pending, Guests: guests}, err
}

func (handler *Handler) loadAdminRoomAccounts(request *http.Request) ([]adminRoomAccount, error) {
	rows, err := handler.service.db.Query(request.Context(), `SELECT account.id,account.email,account.display_name,
		CASE WHEN account.rooms_only_account THEN 'rooms_only' ELSE 'sharedrive' END,
		account.rooms_access_enabled,count(membership.room_id)
		FROM users account LEFT JOIN room_members membership ON membership.user_id=account.id
		WHERE account.is_active=TRUE AND (account.role <> 'guest' OR membership.user_id IS NOT NULL)
		GROUP BY account.id ORDER BY account.display_name,account.email`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]adminRoomAccount, 0)
	for rows.Next() {
		var item adminRoomAccount
		if err := rows.Scan(&item.ID, &item.Email, &item.DisplayName, &item.AccountType, &item.AccessEnabled, &item.RoomCount); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (handler *Handler) loadAdminPendingRoomUsers(request *http.Request) ([]adminPendingRoomUser, error) {
	rows, err := handler.service.db.Query(request.Context(), `SELECT invitation.id,invitation.email,room.id,room.name,
		invitation.role,invitation.expires_at FROM room_member_invitations invitation
		JOIN rooms room ON room.id=invitation.room_id
		WHERE invitation.accepted_at IS NULL AND invitation.expires_at > now() AND room.archived_at IS NULL
		ORDER BY invitation.created_at DESC LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]adminPendingRoomUser, 0)
	for rows.Next() {
		var item adminPendingRoomUser
		if err := rows.Scan(&item.ID, &item.Email, &item.RoomID, &item.RoomName, &item.Role, &item.ExpiresAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (handler *Handler) loadAdminRoomGuests(request *http.Request) ([]adminRoomGuest, error) {
	rows, err := handler.service.db.Query(request.Context(), `SELECT session.id,session.display_name,invite.label,
		room.id,room.name,session.expires_at,session.last_accessed_at
		FROM room_guest_sessions session JOIN room_invites invite ON invite.id=session.invite_id
		JOIN rooms room ON room.id=invite.room_id
		WHERE session.revoked_at IS NULL AND session.expires_at > now()
			AND invite.revoked_at IS NULL AND invite.expires_at > now() AND room.archived_at IS NULL
		ORDER BY COALESCE(session.last_accessed_at,session.created_at) DESC LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]adminRoomGuest, 0)
	for rows.Next() {
		var item adminRoomGuest
		if err := rows.Scan(&item.SessionID, &item.DisplayName, &item.Invitation, &item.RoomID, &item.RoomName,
			&item.ExpiresAt, &item.LastAccessedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (handler *Handler) AdminSetUserAccess(w http.ResponseWriter, request *http.Request) {
	userID, err := uuid.Parse(chi.URLParam(request, "userID"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	var input struct {
		Enabled *bool `json:"enabled"`
	}
	if err := json.NewDecoder(request.Body).Decode(&input); err != nil || input.Enabled == nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	tag, err := handler.service.db.Exec(request.Context(), `UPDATE users SET rooms_access_enabled=$1,updated_at=now()
		WHERE id=$2 AND is_active=TRUE`, *input.Enabled, userID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		handler.respondError(w, ErrNotFound)
		return
	}
	if !*input.Enabled {
		handler.disconnectUserFromRooms(request, userID)
	}
	if handler.service.audit != nil {
		actor := middleware.UserFromContext(request.Context())
		handler.service.audit.Log(request.Context(), audit.Event{Type: audit.EventRoomsUserAccessChanged,
			ActorID: &actor.ID, TargetUserID: &userID, IsAdminAction: true,
			Metadata: map[string]any{"enabled": *input.Enabled}})
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (handler *Handler) disconnectUserFromRooms(request *http.Request, userID uuid.UUID) {
	rows, err := handler.service.db.Query(request.Context(), `SELECT room_id FROM room_members WHERE user_id=$1`, userID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var roomID uuid.UUID
		if rows.Scan(&roomID) == nil {
			handler.publishRoomEvent(request.Context(), roomID, roomEvent{Type: "user_rooms_access_revoked", UserID: userID})
		}
	}
}
