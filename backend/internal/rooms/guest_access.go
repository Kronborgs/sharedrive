package rooms

import (
	"context"

	"github.com/google/uuid"
)

func (handler *Handler) guestAccessByID(ctx context.Context, rawSessionID, rawRoomID string) (roomGuestAccess, error) {
	sessionID, err := uuid.Parse(rawSessionID)
	if err != nil {
		return roomGuestAccess{}, ErrForbidden
	}
	roomID, err := uuid.Parse(rawRoomID)
	if err != nil {
		return roomGuestAccess{}, ErrForbidden
	}
	var access roomGuestAccess
	err = handler.service.db.QueryRow(ctx, `SELECT rgs.id, ri.id, r.id, r.name, r.slug, r.owner_id, rgs.display_name,
		ri.can_chat, ri.can_upload, ri.can_voice, ri.can_share_screen, rgs.expires_at
		FROM room_guest_sessions rgs JOIN room_invites ri ON ri.id=rgs.invite_id
		JOIN rooms r ON r.id=ri.room_id JOIN users owner ON owner.id=r.owner_id
		WHERE rgs.id=$1 AND r.id=$2 AND rgs.revoked_at IS NULL AND rgs.expires_at>now()
		AND ri.revoked_at IS NULL AND ri.expires_at>now() AND r.archived_at IS NULL AND owner.is_active=TRUE`,
		sessionID, roomID).Scan(&access.SessionID, &access.InviteID, &access.RoomID, &access.RoomName,
		&access.RoomSlug, &access.OwnerID, &access.DisplayName, &access.CanChat, &access.CanUpload,
		&access.CanVoice, &access.CanShareScreen, &access.ExpiresAt)
	if err != nil {
		return roomGuestAccess{}, ErrForbidden
	}
	return access, nil
}
