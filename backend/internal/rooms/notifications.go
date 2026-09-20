package rooms

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const unreadDigestInterval = 12 * time.Hour

// UnreadMessageMailer sends one digest containing all due unread messages for a user.
type UnreadMessageMailer interface {
	SendUnreadMessageDigest(ctx context.Context, toEmail, recipientName, summary string) error
}

type unreadDigestItem struct {
	chatName   string
	senderName string
	body       string
	createdAt  time.Time
	messageURL string
}

type unreadDigestRecipient struct {
	userID        uuid.UUID
	toEmail       string
	recipientName string
	items         []unreadDigestItem
}

const unreadMessageDigestQuery = `
	SELECT account.id, account.email, COALESCE(NULLIF(account.display_name, ''), account.email),
	       message.id, room.name, COALESCE(NULLIF(sender.display_name, ''), sender.email, 'Ukendt afsender'),
	       message.body, message.created_at,
	       $1::text || '/rooms/' || room.slug || '?message_id=' || message.id::text || '#message-' || message.id::text
	FROM room_messages message
	JOIN rooms room ON room.id = message.room_id AND room.archived_at IS NULL
	JOIN room_members membership ON membership.room_id = message.room_id
	JOIN users account ON account.id = membership.user_id AND account.is_active = TRUE
	JOIN users sender ON sender.id = message.sender_user_id
	LEFT JOIN room_read_state read_state ON read_state.room_id = message.room_id AND read_state.user_id = membership.user_id
	LEFT JOIN room_messages last_read ON last_read.id = read_state.last_read_message_id
	LEFT JOIN room_unread_email_digest digest ON digest.user_id = membership.user_id
	WHERE message.deleted_at IS NULL
	  AND message.sender_user_id <> membership.user_id
	  AND message.created_at >= membership.joined_at
	  AND (last_read.id IS NULL OR (message.created_at, message.id) > (last_read.created_at, last_read.id))
	  AND NOT EXISTS (
		SELECT 1 FROM room_messages reply
		WHERE reply.room_id = message.room_id AND reply.sender_user_id = membership.user_id
		  AND reply.deleted_at IS NULL AND (reply.created_at, reply.id) > (message.created_at, message.id)
	  )
	  AND (digest.last_sent_at IS NULL OR digest.last_sent_at <= now() - interval '12 hours')
	  AND ($2::uuid IS NULL OR account.id = $2::uuid)

	UNION ALL

	SELECT account.id, account.email, COALESCE(NULLIF(account.display_name, ''), account.email),
	       message.id, COALESCE(NULLIF(conversation.name, ''), NULLIF(source.name, ''), 'Privat chat'),
	       COALESCE(NULLIF(sender.display_name, ''), sender.email, 'Ukendt afsender'),
	       message.body, message.created_at,
	       $1::text || '/rooms/direct/' || conversation.id::text || '?message_id=' || message.id::text || '#message-' || message.id::text
	FROM direct_messages message
	JOIN direct_conversations conversation ON conversation.id = message.conversation_id
	LEFT JOIN rooms source ON source.id = conversation.source_room_id
	JOIN direct_conversation_members membership ON membership.conversation_id = message.conversation_id AND membership.hidden_at IS NULL
	JOIN users account ON account.id = membership.user_id AND account.is_active = TRUE
	JOIN users sender ON sender.id = message.sender_user_id
	LEFT JOIN direct_read_state read_state ON read_state.conversation_id = message.conversation_id AND read_state.user_id = membership.user_id
	LEFT JOIN direct_messages last_read ON last_read.id = read_state.last_read_message_id
	LEFT JOIN room_unread_email_digest digest ON digest.user_id = membership.user_id
	WHERE message.deleted_at IS NULL
	  AND message.sender_user_id <> membership.user_id
	  AND (last_read.id IS NULL OR (message.created_at, message.id) > (last_read.created_at, last_read.id))
	  AND NOT EXISTS (
		SELECT 1 FROM direct_messages reply
		WHERE reply.conversation_id = message.conversation_id AND reply.sender_user_id = membership.user_id
		  AND reply.deleted_at IS NULL AND (reply.created_at, reply.id) > (message.created_at, message.id)
	  )
	  AND (digest.last_sent_at IS NULL OR digest.last_sent_at <= now() - interval '12 hours')
	  AND ($2::uuid IS NULL OR account.id = $2::uuid)
	ORDER BY 1, 8, 4`

// SendUnreadMessageEmails sends one digest per due user, never one email per message.
// It refreshes the unread set under a per-user row lock immediately before sending,
// so messages read while another digest is being processed are not emailed.
func (service *Service) SendUnreadMessageEmails(ctx context.Context, mailer UnreadMessageMailer, appURL string) error {
	if mailer == nil || service.cryptor == nil {
		return nil
	}
	appURL = strings.TrimRight(appURL, "/")
	rows, err := service.db.Query(ctx, unreadMessageDigestQuery, appURL, nil)
	if err != nil {
		return err
	}
	users := make(map[uuid.UUID]struct{})
	for rows.Next() {
		var userID uuid.UUID
		var email, name string
		var messageID uuid.UUID
		var chat, sender, body, link string
		var created time.Time
		if err := rows.Scan(&userID, &email, &name, &messageID, &chat, &sender, &body, &created, &link); err != nil {
			rows.Close()
			return err
		}
		users[userID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	var lastErr error
	for userID := range users {
		if err := service.sendUnreadDigestForUser(ctx, mailer, appURL, userID); err != nil {
			lastErr = err
		}
	}
	return lastErr
}

func (service *Service) sendUnreadDigestForUser(ctx context.Context, mailer UnreadMessageMailer, appURL string, userID uuid.UUID) error {
	tx, err := service.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `INSERT INTO room_unread_email_digest(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING`, userID); err != nil {
		return err
	}
	var lastSent time.Time
	if err := tx.QueryRow(ctx, `SELECT COALESCE(last_sent_at, 'epoch'::timestamptz) FROM room_unread_email_digest WHERE user_id=$1 FOR UPDATE`, userID).Scan(&lastSent); err != nil {
		return err
	}
	if time.Since(lastSent) < unreadDigestInterval {
		return nil
	}

	rows, err := tx.Query(ctx, unreadMessageDigestQuery, appURL, userID)
	if err != nil {
		return err
	}
	digest := unreadDigestRecipient{userID: userID}
	for rows.Next() {
		var item unreadDigestItem
		var messageID uuid.UUID
		if err := rows.Scan(&digest.userID, &digest.toEmail, &digest.recipientName, &messageID, &item.chatName, &item.senderName, &item.body, &item.createdAt, &item.messageURL); err != nil {
			rows.Close()
			return err
		}
		item.body, err = service.notificationBody(item.body)
		if err != nil {
			rows.Close()
			return err
		}
		digest.items = append(digest.items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if len(digest.items) == 0 {
		return tx.Commit(ctx)
	}
	if err := mailer.SendUnreadMessageDigest(ctx, digest.toEmail, digest.recipientName, formatUnreadDigest(digest.items)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE room_unread_email_digest SET last_sent_at=now() WHERE user_id=$1`, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func formatUnreadDigest(items []unreadDigestItem) string {
	var summary strings.Builder
	for _, item := range items {
		fmt.Fprintf(&summary, "• %s — %s (%s)\n%s\nÅbn beskeden: %s\n\n",
			item.chatName, item.senderName, item.createdAt.Local().Format("02-01-2006 15:04"), messageSnippet(item.body), item.messageURL)
	}
	return summary.String()
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