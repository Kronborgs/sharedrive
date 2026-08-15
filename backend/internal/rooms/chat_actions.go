package rooms

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (service *Service) UpdateMessage(ctx context.Context, actorID, roomID, messageID uuid.UUID, body string) (Message, error) {
	if _, err := service.Get(ctx, actorID, roomID); err != nil {
		return Message{}, err
	}
	body, err := NormalizeMessage(body, service.ChatMaxLength(ctx))
	if err != nil {
		return Message{}, err
	}
	if service.cryptor == nil {
		return Message{}, ErrEncryptionUnavailable
	}
	encrypted, err := service.cryptor.encrypt(body)
	if err != nil {
		return Message{}, err
	}
	var message Message
	err = service.db.QueryRow(ctx, `UPDATE room_messages SET body = $1, edited_at = now()
		WHERE id = $2 AND room_id = $3 AND sender_user_id = $4 AND deleted_at IS NULL
		RETURNING id, room_id, sender_user_id, body, reply_to_message_id, created_at, edited_at, deleted_at`,
		encrypted, messageID, roomID, actorID).Scan(&message.ID, &message.RoomID, &message.SenderUserID, &message.Body, &message.ReplyToMessageID, &message.CreatedAt, &message.EditedAt, &message.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Message{}, ErrForbidden
	}
	message.Body = body
	return message, err
}

func (service *Service) DeleteMessage(ctx context.Context, actorID, roomID, messageID uuid.UUID) error {
	if _, err := service.Get(ctx, actorID, roomID); err != nil {
		return err
	}
	tag, err := service.db.Exec(ctx, `UPDATE room_messages SET deleted_at = now(), edited_at = now()
		WHERE id = $1 AND room_id = $2 AND sender_user_id = $3 AND deleted_at IS NULL`, messageID, roomID, actorID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrForbidden
	}
	return nil
}

func normalizeEmoji(emoji string) (string, error) {
	emoji = strings.TrimSpace(emoji)
	if emoji == "" || utf8.RuneCountInString(emoji) > 8 {
		return "", ErrInvalidMessage
	}
	return emoji, nil
}

func (service *Service) AddReaction(ctx context.Context, actorID, roomID, messageID uuid.UUID, emoji string) error {
	if _, err := service.Get(ctx, actorID, roomID); err != nil {
		return err
	}
	emoji, err := normalizeEmoji(emoji)
	if err != nil {
		return err
	}
	var messageExists bool
	if err := service.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM room_messages WHERE id=$1 AND room_id=$2 AND deleted_at IS NULL)`, messageID, roomID).Scan(&messageExists); err != nil {
		return err
	}
	if !messageExists {
		return ErrNotFound
	}
	_, err = service.db.Exec(ctx, `INSERT INTO room_reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, messageID, actorID, emoji)
	return err
}

func (service *Service) RemoveReaction(ctx context.Context, actorID, roomID, messageID uuid.UUID, emoji string) error {
	if _, err := service.Get(ctx, actorID, roomID); err != nil {
		return err
	}
	emoji, err := normalizeEmoji(emoji)
	if err != nil {
		return err
	}
	_, err = service.db.Exec(ctx, `DELETE FROM room_reactions rr USING room_messages m WHERE rr.message_id=m.id AND rr.message_id=$1 AND rr.user_id=$2 AND rr.emoji=$3 AND m.room_id=$4`, messageID, actorID, emoji, roomID)
	return err
}

func (service *Service) MarkRead(ctx context.Context, actorID, roomID, messageID uuid.UUID) error {
	if _, err := service.Get(ctx, actorID, roomID); err != nil {
		return err
	}
	var exists bool
	if err := service.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM room_messages WHERE id=$1 AND room_id=$2)`, messageID, roomID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	_, err := service.db.Exec(ctx, `INSERT INTO room_read_state(room_id,user_id,last_read_message_id) VALUES($1,$2,$3)
		ON CONFLICT(room_id,user_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id, updated_at=now()`, roomID, actorID, messageID)
	return err
}
