package auth

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func acceptPendingRoomMemberships(ctx context.Context, tx pgx.Tx, tokenID string, userID uuid.UUID) error {
	if _, err := tx.Exec(ctx, `INSERT INTO room_members (room_id,user_id,role,added_by)
		SELECT invitation.room_id,$2,invitation.role,invitation.created_by
		FROM room_member_invitations invitation
		JOIN rooms room ON room.id=invitation.room_id AND room.archived_at IS NULL
		WHERE invitation.invitation_token_id=$1 AND invitation.accepted_at IS NULL
			AND invitation.expires_at > now()
		ON CONFLICT (room_id,user_id) DO NOTHING`, tokenID, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO group_members (group_id,user_id)
		SELECT room.managed_group_id,$2
		FROM room_member_invitations invitation
		JOIN rooms room ON room.id=invitation.room_id AND room.archived_at IS NULL
		WHERE invitation.invitation_token_id=$1 AND invitation.accepted_at IS NULL
			AND invitation.expires_at > now()
		ON CONFLICT DO NOTHING`, tokenID, userID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE room_member_invitations SET accepted_at=now()
		WHERE invitation_token_id=$1 AND accepted_at IS NULL AND expires_at > now()`, tokenID)
	return err
}
