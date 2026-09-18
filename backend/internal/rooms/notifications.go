package rooms

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
)

// UnreadMessageMailer sends one reminder for one unread message.
type UnreadMessageMailer interface {
	SendUnreadMessageReminder(ctx context.Context, toEmail, recipientName, chatName, senderName, snippet, messageURL string) error
}

type unreadMessageEmail struct {
	kind          string
	messageID     uuid.UUID
	userID        uuid.UUID
	toEmail       string
	recipientName string
	chatName      string
	senderName    string
	storedBody    string
	messageURL    string
}

// SendUnreadMessageEmails sends due reminders. A separate tracking row is kept
// for every user/message pair, so unread messages in different chats do not
// collapse into one notification and each message can be reminded every 12h.
func (service *Service) SendUnreadMessageEmails(ctx context.Context, mailer UnreadMessageMailer, appURL string) error {
	if mailer == nil || service.cryptor == nil {
		return nil
	}

	rows, err := service.db.Query(ctx, `
		SELECT pending.message_kind, pending.message_id, pending.user_id,
		       pending.email, pending.recipient_name, pending.chat_name,
		       pending.sender_name, pending.body, pending.message_url
		FROM (
			SELECT 'room'::text AS message_kind, message.id AS message_id, account.id AS user_id,
			       account.email, COALESCE(NULLIF(account.display_name, ''), account.email) AS recipient_name,
			       room.name AS chat_name,
			       COALESCE(NULLIF(sender.display_name, ''), sender.email, 'Ukendt afsender') AS sender_name,
			       message.body,
			       $1::text || '/rooms/' || room.slug AS message_url
			FROM room_messages message
			JOIN rooms room ON room.id = message.room_id AND room.archived_at IS NULL
			JOIN room_members membership ON membership.room_id = message.room_id
			JOIN users account ON account.id = membership.user_id AND account.is_active = TRUE
			JOIN users sender ON sender.id = message.sender_user_id
			LEFT JOIN room_read_state read_state
			  ON read_state.room_id = message.room_id AND read_state.user_id = membership.user_id
			LEFT JOIN room_messages last_read
			  ON last_read.id = read_state.last_read_message_id
			WHERE message.deleted_at IS NULL
			  AND message.sender_user_id <> membership.user_id
			  AND message.created_at >= membership.joined_at
			  AND (last_read.id IS NULL OR (message.created_at, message.id) > (last_read.created_at, last_read.id))
			  AND NOT EXISTS (
				SELECT 1 FROM room_unread_email_notifications notification
				WHERE notification.user_id = membership.user_id
				  AND notification.message_kind = 'room'
				  AND notification.message_id = message.id
				  AND notification.last_sent_at IS NOT NULL
				  AND notification.last_sent_at > now() - interval '12 hours'
			  )

			UNION ALL

			SELECT 'direct'::text AS message_kind, message.id AS message_id, account.id AS user_id,
			       account.email, COALESCE(NULLIF(account.display_name, ''), account.email) AS recipient_name,
			       COALESCE(NULLIF(conversation.name, ''), NULLIF(source.name, ''), 'Privat chat') AS chat_name,
			       COALESCE(NULLIF(sender.display_name, ''), sender.email, 'Ukendt afsender') AS sender_name,
			       message.body,
			       $1::text || '/rooms/direct/' || conversation.id::text AS message_url
			FROM direct_messages message
			JOIN direct_conversations conversation ON conversation.id = message.conversation_id
			LEFT JOIN rooms source ON source.id = conversation.source_room_id
			JOIN direct_conversation_members membership
			  ON membership.conversation_id = message.conversation_id AND membership.hidden_at IS NULL
			JOIN users account ON account.id = membership.user_id AND account.is_active = TRUE
			JOIN users sender ON sender.id = message.sender_user_id
			LEFT JOIN direct_read_state read_state
			  ON read_state.conversation_id = message.conversation_id AND read_state.user_id = membership.user_id
			LEFT JOIN direct_messages last_read
			  ON last_read.id = read_state.last_read_message_id
			WHERE message.deleted_at IS NULL
			  AND message.sender_user_id <> membership.user_id
			  AND (last_read.id IS NULL OR (message.created_at, message.id) > (last_read.created_at, last_read.id))
			  AND NOT EXISTS (
				SELECT 1 FROM room_unread_email_notifications notification
				WHERE notification.user_id = membership.user_id
				  AND notification.message_kind = 'direct'
				  AND notification.message_id = message.id
				  AND notification.last_sent_at IS NOT NULL
				  AND notification.last_sent_at > now() - interval '12 hours'
			  )
		) pending
		ORDER BY pending.user_id, pending.message_kind, pending.message_id`, strings.TrimRight(appURL, "/"))
	if err != nil {
		return err
	}
	defer rows.Close()

	var lastErr error
	for rows.Next() {
		var item unreadMessageEmail
		if err := rows.Scan(&item.kind, &item.messageID, &item.userID, &item.toEmail, &item.recipientName, &item.chatName, &item.senderName, &item.storedBody, &item.messageURL); err != nil {
			return err
		}
		body, err := service.notificationBody(item.storedBody)
		if err != nil {
			lastErr = err
			continue
		}
		if err := mailer.SendUnreadMessageReminder(ctx, item.toEmail, item.recipientName, item.chatName, item.senderName, messageSnippet(body), item.messageURL); err != nil {
			lastErr = err
			continue
		}
		if _, err := service.db.Exec(ctx, `INSERT INTO room_unread_email_notifications(user_id, message_kind, message_id, last_sent_at)
			VALUES($1, $2, $3, now())
			ON CONFLICT(user_id, message_kind, message_id) DO UPDATE SET last_sent_at = EXCLUDED.last_sent_at`, item.userID, item.kind, item.messageID); err != nil {
			lastErr = err
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return lastErr
}

func (service *Service) notificationBody(storedBody string) (string, error) {
	if strings.HasPrefix(storedBody, "v1:") {
		return service.cryptor.decrypt(storedBody)
	}
	return storedBody, nil
}

func messageSnippet(body string) string {
	body = strings.Join(strings.Fields(body), " ")
	if utf8.RuneCountInString(body) <= 240 {
		return body
	}
	runes := []rune(body)
	return string(runes[:240]) + "…"
}