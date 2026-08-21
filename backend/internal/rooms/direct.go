package rooms

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func canonicalDirectPair(first, second uuid.UUID) (uuid.UUID, uuid.UUID) {
	if first.String() < second.String() {
		return first, second
	}
	return second, first
}

func (service *Service) CreateDirectConversation(ctx context.Context, actorID, sourceRoomID, otherUserID uuid.UUID) (DirectConversation, error) {
	if actorID == otherUserID {
		return DirectConversation{}, ErrInvalidName
	}
	if !service.usersShareActiveRoom(ctx, actorID, otherUserID, sourceRoomID) {
		return DirectConversation{}, ErrNotFound
	}
	first, second := canonicalDirectPair(actorID, otherUserID)
	var conversation DirectConversation
	err := service.db.QueryRow(ctx, `INSERT INTO direct_conversations(source_room_id,user_one_id,user_two_id)
		VALUES($1,$2,$3) ON CONFLICT(source_room_id,user_one_id,user_two_id) DO UPDATE SET updated_at=direct_conversations.updated_at
		RETURNING id,created_at,updated_at`, sourceRoomID, first, second).Scan(&conversation.ID, &conversation.CreatedAt, &conversation.UpdatedAt)
	if err != nil {
		return DirectConversation{}, err
	}
	return service.directConversationForActor(ctx, actorID, conversation.ID)
}

func (service *Service) usersShareActiveRoom(ctx context.Context, actorID, otherUserID, sourceRoomID uuid.UUID) bool {
	var allowed bool
	err := service.db.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM room_members mine
		JOIN room_members other ON other.room_id=mine.room_id AND other.user_id=$2
		JOIN rooms room ON room.id=mine.room_id AND room.archived_at IS NULL
		JOIN users actor ON actor.id=mine.user_id AND actor.is_active=TRUE AND actor.rooms_access_enabled=TRUE
		JOIN users target ON target.id=other.user_id AND target.is_active=TRUE AND target.rooms_access_enabled=TRUE
		WHERE mine.user_id=$1 AND mine.room_id=$3)`, actorID, otherUserID, sourceRoomID).Scan(&allowed)
	return err == nil && allowed
}

func (service *Service) directConversationForActor(ctx context.Context, actorID, conversationID uuid.UUID) (DirectConversation, error) {
	var result DirectConversation
	err := service.db.QueryRow(ctx, `SELECT conversation.id,conversation.source_room_id,source.name,source.slug,
		CASE WHEN conversation.user_one_id=$1 THEN conversation.user_two_id ELSE conversation.user_one_id END,
		other_user.display_name,other_user.email,conversation.created_at,conversation.updated_at
		FROM direct_conversations conversation
		JOIN users other_user ON other_user.id=CASE WHEN conversation.user_one_id=$1 THEN conversation.user_two_id ELSE conversation.user_one_id END JOIN rooms source ON source.id=conversation.source_room_id
		WHERE conversation.id=$2 AND (conversation.user_one_id=$1 OR conversation.user_two_id=$1)`, actorID, conversationID).Scan(
		&result.ID, &result.SourceRoomID, &result.SourceRoomName, &result.SourceRoomSlug, &result.OtherUserID, &result.OtherDisplayName, &result.OtherEmail, &result.CreatedAt, &result.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !service.usersShareActiveRoom(ctx, actorID, result.OtherUserID, result.SourceRoomID)) {
		return DirectConversation{}, ErrNotFound
	}
	return result, err
}

func (service *Service) ListDirectConversations(ctx context.Context, actorID uuid.UUID) ([]DirectConversation, error) {
	rows, err := service.db.Query(ctx, `SELECT conversation.id,conversation.source_room_id,source.name,source.slug,
		CASE WHEN conversation.user_one_id=$1 THEN conversation.user_two_id ELSE conversation.user_one_id END,
		other_user.display_name,other_user.email,conversation.created_at,conversation.updated_at,
		COALESCE((SELECT count(*) FROM direct_messages message
			LEFT JOIN direct_read_state read_state ON read_state.conversation_id=conversation.id AND read_state.user_id=$1
			WHERE message.conversation_id=conversation.id AND message.sender_user_id<>$1 AND message.deleted_at IS NULL
			AND (read_state.last_read_message_id IS NULL OR (message.created_at,message.id)>(SELECT marker.created_at,marker.id FROM direct_messages marker WHERE marker.id=read_state.last_read_message_id))),0)::int
		FROM direct_conversations conversation
		JOIN users other_user ON other_user.id=CASE WHEN conversation.user_one_id=$1 THEN conversation.user_two_id ELSE conversation.user_one_id END JOIN rooms source ON source.id=conversation.source_room_id
		WHERE (conversation.user_one_id=$1 OR conversation.user_two_id=$1)
		ORDER BY conversation.updated_at DESC,conversation.id DESC`, actorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]DirectConversation, 0)
	for rows.Next() {
		var item DirectConversation
		if err := rows.Scan(&item.ID, &item.SourceRoomID, &item.SourceRoomName, &item.SourceRoomSlug, &item.OtherUserID, &item.OtherDisplayName, &item.OtherEmail, &item.CreatedAt, &item.UpdatedAt, &item.UnreadCount); err != nil {
			return nil, err
		}
		if service.usersShareActiveRoom(ctx, actorID, item.OtherUserID, item.SourceRoomID) {
			result = append(result, item)
		}
	}
	return result, rows.Err()
}

func (service *Service) MarkDirectConversationRead(ctx context.Context, actorID, conversationID uuid.UUID) error {
	if _, err := service.directConversationForActor(ctx, actorID, conversationID); err != nil {
		return err
	}
	var messageID uuid.UUID
	err := service.db.QueryRow(ctx, `SELECT id FROM direct_messages WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, conversationID).Scan(&messageID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = service.db.Exec(ctx, `INSERT INTO direct_read_state(conversation_id,user_id,last_read_message_id,updated_at)
		VALUES($1,$2,$3,now()) ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_read_message_id=EXCLUDED.last_read_message_id,updated_at=EXCLUDED.updated_at`, conversationID, actorID, messageID)
	return err
}

func (service *Service) CreateDirectMessage(ctx context.Context, actorID, conversationID uuid.UUID, body string, replyTo *uuid.UUID) (DirectMessage, error) {
	conversation, err := service.directConversationForActor(ctx, actorID, conversationID)
	if err != nil {
		return DirectMessage{}, err
	}
	if err := service.maintainChatStorage(ctx); err != nil {
		return DirectMessage{}, err
	}
	body, err = NormalizeMessage(body, service.ChatMaxLength(ctx))
	if err != nil {
		return DirectMessage{}, err
	}
	if service.cryptor == nil {
		return DirectMessage{}, ErrEncryptionUnavailable
	}
	if replyTo != nil {
		var exists bool
		if err := service.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM direct_messages WHERE id=$1 AND conversation_id=$2 AND deleted_at IS NULL)`, *replyTo, conversationID).Scan(&exists); err != nil || !exists {
			return DirectMessage{}, ErrNotFound
		}
	}
	plainBody := body
	body, err = service.cryptor.encrypt(body)
	if err != nil {
		return DirectMessage{}, err
	}
	var message DirectMessage
	err = service.db.QueryRow(ctx, `INSERT INTO direct_messages(conversation_id,sender_user_id,body,reply_to_message_id)
		VALUES($1,$2,$3,$4) RETURNING id,conversation_id,sender_user_id,body,reply_to_message_id,created_at,edited_at,deleted_at`, conversationID, actorID, body, replyTo).Scan(
		&message.ID, &message.ConversationID, &message.SenderUserID, &message.Body, &message.ReplyToMessageID, &message.CreatedAt, &message.EditedAt, &message.DeletedAt)
	if err != nil {
		return DirectMessage{}, err
	}
	_, err = service.db.Exec(ctx, `UPDATE direct_conversations SET updated_at=now() WHERE id=$1`, conversation.ID)
	message.Body = plainBody
	message.SenderName = ""
	return message, err
}

func (service *Service) ListDirectMessages(ctx context.Context, actorID, conversationID uuid.UUID, limit int, cursor *uuid.UUID) (DirectMessagePage, error) {
	if _, err := service.directConversationForActor(ctx, actorID, conversationID); err != nil {
		return DirectMessagePage{}, err
	}
	if service.cryptor == nil {
		return DirectMessagePage{}, ErrEncryptionUnavailable
	}
	limit = normalizeMessagePageLimit(limit)
	rows, err := service.db.Query(ctx, `SELECT message.id,message.conversation_id,message.sender_user_id,COALESCE(account.display_name,account.email),message.body,message.reply_to_message_id,message.created_at,message.edited_at,message.deleted_at
		FROM direct_messages message JOIN users account ON account.id=message.sender_user_id
		WHERE message.conversation_id=$1 AND ($3::uuid IS NULL OR (message.created_at,message.id)<(SELECT cursor_message.created_at,cursor_message.id FROM direct_messages cursor_message WHERE cursor_message.id=$3 AND cursor_message.conversation_id=$1))
		ORDER BY message.created_at DESC,message.id DESC LIMIT $2`, conversationID, limit+1, cursor)
	if err != nil {
		return DirectMessagePage{}, err
	}
	defer rows.Close()
	messages := make([]DirectMessage, 0, limit+1)
	for rows.Next() {
		var message DirectMessage
		if err := rows.Scan(&message.ID, &message.ConversationID, &message.SenderUserID, &message.SenderName, &message.Body, &message.ReplyToMessageID, &message.CreatedAt, &message.EditedAt, &message.DeletedAt); err != nil {
			return DirectMessagePage{}, err
		}
		if strings.HasPrefix(message.Body, "v1:") {
			message.Body, err = service.cryptor.decrypt(message.Body)
			if err != nil {
				return DirectMessagePage{}, err
			}
		}
		messages = append(messages, message)
	}
	page := DirectMessagePage{Messages: messages}
	if len(messages) > limit {
		page.NextCursor = messages[limit].ID.String()
		page.Messages = messages[:limit]
	}
	return page, rows.Err()
}

func (service *Service) AddDirectFileResource(ctx context.Context, actorID, conversationID, fileID uuid.UUID, messageID *uuid.UUID) (DirectResource, error) {
	conversation, err := service.directConversationForActor(ctx, actorID, conversationID)
	if err != nil {
		return DirectResource{}, err
	}
	if err := service.authorizeResourceAttach(ctx, actorID, ResourceFile, fileID); err != nil {
		return DirectResource{}, err
	}
	if messageID != nil {
		var allowed bool
		err = service.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM direct_messages WHERE id=$1 AND conversation_id=$2 AND sender_user_id=$3 AND deleted_at IS NULL)`, *messageID, conversationID, actorID).Scan(&allowed)
		if err != nil || !allowed {
			return DirectResource{}, ErrNotFound
		}
	}
	otherUserID := conversation.OtherUserID
	tx, err := service.db.Begin(ctx)
	if err != nil {
		return DirectResource{}, err
	}
	defer tx.Rollback(ctx)
	var resource DirectResource
	err = tx.QueryRow(ctx, `INSERT INTO direct_resources(conversation_id,file_id,added_by,message_id)
		VALUES($1,$2,$3,$4) ON CONFLICT(conversation_id,file_id) DO NOTHING
		RETURNING id,conversation_id,file_id,added_by,message_id,created_at`, conversationID, fileID, actorID, messageID).Scan(&resource.ID, &resource.ConversationID, &resource.FileID, &resource.AddedBy, &resource.MessageID, &resource.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return DirectResource{}, ErrResourceExists
	}
	if err != nil {
		return DirectResource{}, err
	}
	if err := ensureDirectFileShare(ctx, tx, actorID, otherUserID, fileID); err != nil {
		return DirectResource{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DirectResource{}, err
	}
	file, err := service.fileSvc.GetAccessible(ctx, fileID.String(), actorID.String())
	if err != nil {
		return DirectResource{}, err
	}
	resource.Name, resource.MimeType = file.Name, file.MimeType
	return resource, nil
}

func ensureDirectFileShare(ctx context.Context, tx pgx.Tx, actorID, otherUserID, fileID uuid.UUID) error {
	_, err := tx.Exec(ctx, `INSERT INTO shares(resource_id,owner_id,grantee_type,grantee_id,can_view,can_upload,can_edit,can_delete,can_reshare,created_by)
		SELECT file.id,file.owner_id,'user',$2,TRUE,FALSE,FALSE,FALSE,FALSE,$3 FROM files file
		WHERE file.id=$1 AND file.deleted_at IS NULL
		AND NOT EXISTS(SELECT 1 FROM shares existing WHERE existing.resource_id=$1 AND existing.grantee_type='user' AND existing.grantee_id=$2 AND existing.revoked_at IS NULL)`, fileID, otherUserID, actorID)
	return err
}

func (service *Service) ListDirectResources(ctx context.Context, actorID, conversationID uuid.UUID) ([]DirectResource, error) {
	if _, err := service.directConversationForActor(ctx, actorID, conversationID); err != nil {
		return nil, err
	}
	rows, err := service.db.Query(ctx, `SELECT resource.id,resource.conversation_id,resource.file_id,resource.added_by,resource.message_id,resource.created_at,file.name,file.mime_type
		FROM direct_resources resource JOIN files file ON file.id=resource.file_id WHERE resource.conversation_id=$1 AND file.deleted_at IS NULL ORDER BY resource.created_at`, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	resources := make([]DirectResource, 0)
	for rows.Next() {
		var resource DirectResource
		if err := rows.Scan(&resource.ID, &resource.ConversationID, &resource.FileID, &resource.AddedBy, &resource.MessageID, &resource.CreatedAt, &resource.Name, &resource.MimeType); err != nil {
			return nil, err
		}
		resources = append(resources, resource)
	}
	return resources, rows.Err()
}
