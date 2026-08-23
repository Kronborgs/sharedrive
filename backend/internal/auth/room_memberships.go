package auth

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func canonicalDirectPair(first, second uuid.UUID) (uuid.UUID, uuid.UUID) {
	if first.String() < second.String() {
		return first, second
	}
	return second, first
}

func acceptPendingDirectChatInvitation(ctx context.Context, tx pgx.Tx, tokenID string, userID uuid.UUID) error {
	var inviterID uuid.UUID
	err := tx.QueryRow(ctx, `SELECT inviter_user_id FROM direct_chat_invitations
		WHERE invitation_token_id=$1 AND accepted_at IS NULL AND expires_at > now()`, tokenID).Scan(&inviterID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var conversationID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT conversation.id FROM direct_conversations conversation
		JOIN direct_conversation_members mine ON mine.conversation_id=conversation.id AND mine.user_id=$1
		JOIN direct_conversation_members other ON other.conversation_id=conversation.id AND other.user_id=$2
		WHERE conversation.kind='direct' GROUP BY conversation.id HAVING count(*)=2 LIMIT 1`, inviterID, userID).Scan(&conversationID)
	if errors.Is(err, pgx.ErrNoRows) {
		first, second := canonicalDirectPair(inviterID, userID)
		if err = tx.QueryRow(ctx, `INSERT INTO direct_conversations(source_room_id,user_one_id,user_two_id,kind,owner_user_id)
			VALUES(NULL,$1,$2,'direct',$3) RETURNING id`, first, second, inviterID).Scan(&conversationID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO direct_conversation_members(conversation_id,user_id,added_by)
			VALUES($1,$2,$2),($1,$3,$2)`, conversationID, inviterID, userID); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE direct_chat_invitations SET accepted_at=now()
		WHERE invitation_token_id=$1 AND accepted_at IS NULL`, tokenID)
	return err
}

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
