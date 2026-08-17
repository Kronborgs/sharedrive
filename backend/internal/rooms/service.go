package rooms

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/files"
	"github.com/yourname/privatedrive/internal/notes"
)

var (
	ErrNotFound       = errors.New("room not found")
	ErrForbidden      = errors.New("room action is not allowed")
	ErrArchived       = errors.New("room is archived")
	ErrMemberExists   = errors.New("user is already a room member")
	ErrMemberNotFound = errors.New("room member not found")
	ErrOwnerRemoval   = errors.New("room owner cannot be removed")
)

type Service struct {
	db      *pgxpool.Pool
	audit   audit.Logger
	cryptor *cryptor
	fileSvc *files.Service
	noteSvc *notes.Service
}

type roomAccess struct {
	ownerID        uuid.UUID
	managedGroupID uuid.UUID
	archived       bool
	actorRole      string
}

func NewService(db *pgxpool.Pool, auditLogger audit.Logger, roomsEncryptKey string, fileSvc *files.Service, noteSvc *notes.Service) *Service {
	cryptor, _ := newCryptor(roomsEncryptKey)
	return &Service{db: db, audit: auditLogger, cryptor: cryptor, fileSvc: fileSvc, noteSvc: noteSvc}
}

func (service *Service) ChatEncryptionReady() bool { return service.cryptor != nil }

// Enabled reports whether the administrator has enabled the Rooms feature.
// The setting is stored in system_settings so it takes effect without a restart.
func (service *Service) Enabled(ctx context.Context) (bool, error) {
	return service.boolSetting(ctx, "rooms_enabled")
}

// VoiceEnabled reports whether an administrator has enabled the optional
// LiveKit voice feature. A missing setting deliberately keeps voice disabled.
func (service *Service) VoiceEnabled(ctx context.Context) (bool, error) {
	return service.boolSetting(ctx, "rooms_voice_enabled")
}

func (service *Service) boolSetting(ctx context.Context, key string) (bool, error) {
	var value string
	err := service.db.QueryRow(ctx, `SELECT value FROM system_settings WHERE key = $1`, key).Scan(&value)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return value == "true", nil
}

const roomColumns = `r.id, r.name, r.slug, r.owner_id, r.managed_group_id,
 r.created_by, r.created_at, r.updated_at, r.archived_at`

func scanRoom(row pgx.Row) (Room, error) {
	var room Room
	err := row.Scan(&room.ID, &room.Name, &room.Slug, &room.OwnerID, &room.ManagedGroupID,
		&room.CreatedBy, &room.CreatedAt, &room.UpdatedAt, &room.ArchivedAt)
	return room, err
}

func scanRoomWithRole(row pgx.Row) (Room, error) {
	var room Room
	err := row.Scan(&room.ID, &room.Name, &room.Slug, &room.OwnerID, &room.ManagedGroupID,
		&room.CreatedBy, &room.CreatedAt, &room.UpdatedAt, &room.ArchivedAt, &room.CurrentRole)
	return room, err
}

func scanRoomWithRoleAndUnread(row pgx.Row) (Room, error) {
	var room Room
	err := row.Scan(&room.ID, &room.Name, &room.Slug, &room.OwnerID, &room.ManagedGroupID,
		&room.CreatedBy, &room.CreatedAt, &room.UpdatedAt, &room.ArchivedAt, &room.CurrentRole,
		&room.UnreadCount)
	return room, err
}

func (service *Service) Create(ctx context.Context, actorID uuid.UUID, name string) (Room, error) {
	normalizedName, err := NormalizeName(name)
	if err != nil {
		return Room{}, err
	}

	tx, err := service.db.Begin(ctx)
	if err != nil {
		return Room{}, err
	}
	defer tx.Rollback(ctx)

	roomID := uuid.New()
	managedGroupID := uuid.New()
	baseSlug := Slugify(normalizedName)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, baseSlug); err != nil {
		return Room{}, err
	}

	slug := baseSlug
	var slugExists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM rooms WHERE lower(slug) = lower($1))`, slug).Scan(&slugExists); err != nil {
		return Room{}, err
	}
	if slugExists {
		slug = fmt.Sprintf("%s-%s", baseSlug, strings.ReplaceAll(roomID.String()[:8], "-", ""))
	}

	if _, err := tx.Exec(ctx, `INSERT INTO groups
		(id, name, description, color, created_by, is_system_managed)
		VALUES ($1, $2, $3, $4, $5, TRUE)`,
		managedGroupID, "room:"+roomID.String(), "Managed by Sharedrive Rooms", "#6b7280", actorID); err != nil {
		return Room{}, err
	}

	room, err := scanRoom(tx.QueryRow(ctx, `INSERT INTO rooms
		(id, name, slug, owner_id, managed_group_id, created_by)
		VALUES ($1, $2, $3, $4, $5, $4)
		RETURNING id, name, slug, owner_id, managed_group_id, created_by, created_at, updated_at, archived_at`,
		roomID, normalizedName, slug, actorID, managedGroupID))
	if err != nil {
		return Room{}, err
	}

	if _, err := tx.Exec(ctx, `INSERT INTO room_members (room_id, user_id, role, added_by)
		VALUES ($1, $2, $3, $2)`, roomID, actorID, RoleOwner); err != nil {
		return Room{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO group_members (group_id, user_id)
		VALUES ($1, $2)`, managedGroupID, actorID); err != nil {
		return Room{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Room{}, err
	}

	room.CurrentRole = RoleOwner
	service.log(ctx, audit.EventRoomCreated, actorID, room, nil, nil)
	return room, nil
}

func (service *Service) List(ctx context.Context, actorID uuid.UUID, includeArchived bool) ([]Room, error) {
	rows, err := service.db.Query(ctx, `SELECT `+roomColumns+`, rm.role, unread.unread_count
		FROM rooms r
		JOIN room_members rm ON rm.room_id = r.id
		LEFT JOIN room_read_state read_state
			ON read_state.room_id = r.id AND read_state.user_id = $1
		LEFT JOIN room_messages last_read_message
			ON last_read_message.id = read_state.last_read_message_id
		LEFT JOIN LATERAL (
			SELECT COUNT(*)::integer AS unread_count
			FROM room_messages unread_message
			WHERE unread_message.room_id = r.id
				AND unread_message.deleted_at IS NULL
				AND unread_message.sender_user_id IS DISTINCT FROM $1
				AND unread_message.created_at >= rm.joined_at
				AND (last_read_message.id IS NULL OR
					(unread_message.created_at, unread_message.id) >
					(last_read_message.created_at, last_read_message.id))
		) unread ON TRUE
		WHERE rm.user_id = $1 AND ($2 OR r.archived_at IS NULL)
		ORDER BY (unread.unread_count > 0) DESC, r.updated_at DESC, r.id DESC`, actorID, includeArchived)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make([]Room, 0)
	for rows.Next() {
		room, err := scanRoomWithRoleAndUnread(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, room)
	}
	return result, rows.Err()
}

func (service *Service) Get(ctx context.Context, actorID, roomID uuid.UUID) (Room, error) {
	room, err := scanRoomWithRole(service.db.QueryRow(ctx, `SELECT `+roomColumns+`, rm.role
		FROM rooms r
		JOIN room_members rm ON rm.room_id = r.id
		WHERE r.id = $1 AND rm.user_id = $2`, roomID, actorID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Room{}, ErrNotFound
	}
	return room, err
}

func (service *Service) GetBySlug(ctx context.Context, actorID uuid.UUID, slug string) (Room, error) {
	room, err := scanRoomWithRole(service.db.QueryRow(ctx, `SELECT `+roomColumns+`, rm.role
		FROM rooms r
		JOIN room_members rm ON rm.room_id = r.id
		WHERE lower(r.slug) = lower($1) AND rm.user_id = $2`, slug, actorID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Room{}, ErrNotFound
	}
	return room, err
}

func (service *Service) UpdateName(ctx context.Context, actorID, roomID uuid.UUID, name string) (Room, error) {
	normalizedName, err := NormalizeName(name)
	if err != nil {
		return Room{}, err
	}

	tx, err := service.db.Begin(ctx)
	if err != nil {
		return Room{}, err
	}
	defer tx.Rollback(ctx)

	access, err := loadAccessForUpdate(ctx, tx, roomID, actorID)
	if err != nil {
		return Room{}, err
	}
	if access.archived {
		return Room{}, ErrArchived
	}
	if access.actorRole != RoleOwner && access.actorRole != RoleModerator {
		return Room{}, ErrForbidden
	}

	room, err := scanRoom(tx.QueryRow(ctx, `UPDATE rooms r
		SET name = $2, updated_at = NOW()
		WHERE r.id = $1
		RETURNING `+strings.ReplaceAll(roomColumns, "r.", ""), roomID, normalizedName))
	if err != nil {
		return Room{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Room{}, err
	}
	room.CurrentRole = access.actorRole
	return room, nil
}

func (service *Service) Archive(ctx context.Context, actorID, roomID uuid.UUID) (Room, error) {
	tx, err := service.db.Begin(ctx)
	if err != nil {
		return Room{}, err
	}
	defer tx.Rollback(ctx)

	access, err := loadAccessForUpdate(ctx, tx, roomID, actorID)
	if err != nil {
		return Room{}, err
	}
	if access.actorRole != RoleOwner {
		return Room{}, ErrForbidden
	}

	room, err := scanRoom(tx.QueryRow(ctx, `UPDATE rooms r
		SET archived_at = COALESCE(archived_at, NOW()), updated_at = NOW()
		WHERE r.id = $1
		RETURNING `+strings.ReplaceAll(roomColumns, "r.", ""), roomID))
	if err != nil {
		return Room{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Room{}, err
	}

	room.CurrentRole = access.actorRole
	service.log(ctx, audit.EventRoomArchived, actorID, room, nil, nil)
	return room, nil
}

func (service *Service) ListMembers(ctx context.Context, actorID, roomID uuid.UUID) ([]Member, error) {
	var member bool
	if err := service.db.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2)`, roomID, actorID).Scan(&member); err != nil {
		return nil, err
	}
	if !member {
		return nil, ErrNotFound
	}

	rows, err := service.db.Query(ctx, `SELECT rm.room_id, rm.user_id, rm.role,
		u.display_name, u.email, rm.joined_at, rm.added_by
		FROM room_members rm
		JOIN users u ON u.id = rm.user_id
		WHERE rm.room_id = $1
		ORDER BY CASE rm.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END,
		         lower(u.display_name), rm.user_id`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	members := make([]Member, 0)
	for rows.Next() {
		var member Member
		if err := rows.Scan(&member.RoomID, &member.UserID, &member.Role, &member.DisplayName,
			&member.Email, &member.JoinedAt, &member.AddedBy); err != nil {
			return nil, err
		}
		members = append(members, member)
	}
	return members, rows.Err()
}

func (service *Service) AddMember(ctx context.Context, actorID, roomID, userID uuid.UUID, role string) error {
	if role != RoleModerator && role != RoleMember {
		return ErrInvalidRole
	}

	tx, err := service.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	access, err := loadAccessForUpdate(ctx, tx, roomID, actorID)
	if err != nil {
		return err
	}
	if access.archived {
		return ErrArchived
	}
	if access.actorRole != RoleOwner && access.actorRole != RoleModerator {
		return ErrForbidden
	}
	if access.actorRole == RoleModerator && role == RoleModerator {
		return ErrForbidden
	}

	var activeUser bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM users WHERE id = $1 AND is_active = TRUE AND rooms_access_enabled = TRUE)`, userID).Scan(&activeUser); err != nil {
		return err
	}
	if !activeUser {
		return ErrMemberNotFound
	}

	tag, err := tx.Exec(ctx, `INSERT INTO room_members (room_id, user_id, role, added_by)
		VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, roomID, userID, role, actorID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrMemberExists
	}
	if _, err := tx.Exec(ctx, `INSERT INTO group_members (group_id, user_id)
		VALUES ($1, $2) ON CONFLICT DO NOTHING`, access.managedGroupID, userID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	room := Room{ID: roomID, ManagedGroupID: access.managedGroupID, OwnerID: access.ownerID}
	service.log(ctx, audit.EventRoomMemberAdded, actorID, room, &userID, map[string]any{"role": role})
	return nil
}

func (service *Service) MemberEmail(ctx context.Context, userID uuid.UUID) (string, error) {
	var email string
	err := service.db.QueryRow(ctx, `SELECT email FROM users WHERE id = $1 AND is_active = TRUE AND rooms_access_enabled = TRUE`, userID).Scan(&email)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrMemberNotFound
	}
	return email, err
}

func (service *Service) AddMemberByEmail(ctx context.Context, actorID, roomID uuid.UUID, email, role string) error {
	var userID uuid.UUID
	err := service.db.QueryRow(ctx, `SELECT id FROM users
		WHERE lower(email) = lower($1) AND is_active = TRUE AND rooms_access_enabled = TRUE`, strings.TrimSpace(email)).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrMemberNotFound
	}
	if err != nil {
		return err
	}
	return service.AddMember(ctx, actorID, roomID, userID, role)
}

func (service *Service) RemoveMember(ctx context.Context, actorID, roomID, userID uuid.UUID) error {
	tx, err := service.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	access, err := loadAccessForUpdate(ctx, tx, roomID, actorID)
	if err != nil {
		return err
	}
	if access.archived {
		return ErrArchived
	}
	if access.actorRole != RoleOwner && access.actorRole != RoleModerator {
		return ErrForbidden
	}

	var targetRole string
	err = tx.QueryRow(ctx, `SELECT role FROM room_members
		WHERE room_id = $1 AND user_id = $2 FOR UPDATE`, roomID, userID).Scan(&targetRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrMemberNotFound
	}
	if err != nil {
		return err
	}
	if targetRole == RoleOwner {
		return ErrOwnerRemoval
	}
	if access.actorRole == RoleModerator && targetRole != RoleMember {
		return ErrForbidden
	}

	if _, err := tx.Exec(ctx, `DELETE FROM room_members WHERE room_id = $1 AND user_id = $2`, roomID, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, access.managedGroupID, userID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	room := Room{ID: roomID, ManagedGroupID: access.managedGroupID, OwnerID: access.ownerID}
	service.log(ctx, audit.EventRoomMemberRemoved, actorID, room, &userID, map[string]any{"role": targetRole})
	return nil
}

func loadAccessForUpdate(ctx context.Context, tx pgx.Tx, roomID, actorID uuid.UUID) (roomAccess, error) {
	var access roomAccess
	var archivedAt any
	err := tx.QueryRow(ctx, `SELECT r.owner_id, r.managed_group_id, r.archived_at, rm.role
		FROM rooms r
		JOIN room_members rm ON rm.room_id = r.id
		WHERE r.id = $1 AND rm.user_id = $2
		FOR UPDATE OF r`, roomID, actorID).Scan(
		&access.ownerID, &access.managedGroupID, &archivedAt, &access.actorRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return roomAccess{}, ErrNotFound
	}
	if err != nil {
		return roomAccess{}, err
	}
	access.archived = archivedAt != nil
	return access, nil
}

func (service *Service) log(ctx context.Context, eventType string, actorID uuid.UUID, room Room, targetUserID *uuid.UUID, metadata map[string]any) {
	if service.audit == nil {
		return
	}
	service.audit.Log(ctx, audit.Event{
		Type:         eventType,
		ActorID:      &actorID,
		TargetUserID: targetUserID,
		ResourceType: "room",
		ResourceID:   &room.ID,
		ResourceName: room.Name,
		Metadata:     metadata,
	})
}
func (service *Service) ChatMaxLength(ctx context.Context) int {
	var value string
	if err := service.db.QueryRow(ctx, `SELECT value FROM system_settings WHERE key = 'rooms_chat_max_length'`).Scan(&value); err != nil {
		return 4000
	}
	length, err := strconv.Atoi(value)
	if err != nil || length < 1 || length > 10000 {
		return 4000
	}
	return length
}

func (service *Service) CreateMessage(ctx context.Context, actorID, roomID uuid.UUID, body string, replyTo *uuid.UUID) (Message, error) {
	if _, err := service.Get(ctx, actorID, roomID); err != nil {
		return Message{}, err
	}
	if err := service.maintainChatStorage(ctx); err != nil {
		return Message{}, err
	}
	body, err := NormalizeMessage(body, service.ChatMaxLength(ctx))
	if err != nil {
		return Message{}, err
	}
	if service.cryptor == nil {
		return Message{}, ErrEncryptionUnavailable
	}
	plainBody := body
	body, err = service.cryptor.encrypt(body)
	if err != nil {
		return Message{}, err
	}
	if replyTo != nil {
		var exists bool
		err = service.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM room_messages WHERE id = $1 AND room_id = $2 AND deleted_at IS NULL)`, *replyTo, roomID).Scan(&exists)
		if err != nil {
			return Message{}, err
		}
		if !exists {
			return Message{}, ErrNotFound
		}
	}
	var message Message
	err = service.db.QueryRow(ctx, `INSERT INTO room_messages (room_id, sender_user_id, body, reply_to_message_id)
		VALUES ($1, $2, $3, $4)
		RETURNING id, room_id, sender_user_id, sender_guest_session_id, body, reply_to_message_id, created_at, edited_at, deleted_at`, roomID, actorID, body, replyTo).Scan(
		&message.ID, &message.RoomID, &message.SenderUserID, &message.SenderGuestSessionID, &message.Body, &message.ReplyToMessageID, &message.CreatedAt, &message.EditedAt, &message.DeletedAt)
	if err == nil {
		message.Body = plainBody
	}
	return message, err
}

func (service *Service) ListMessages(ctx context.Context, actorID, roomID uuid.UUID, limit int, cursor *uuid.UUID) (MessagePage, error) {
	if _, err := service.Get(ctx, actorID, roomID); err != nil {
		return MessagePage{}, err
	}
	if service.cryptor == nil {
		return MessagePage{}, ErrEncryptionUnavailable
	}
	limit = normalizeMessagePageLimit(limit)
	messages, err := service.queryMessagePage(ctx, roomID, limit+1, cursor)
	if err != nil {
		return MessagePage{}, err
	}
	if err := service.loadMessageReactions(ctx, messages); err != nil {
		return MessagePage{}, err
	}
	return buildMessagePage(messages, limit), nil
}

func normalizeMessagePageLimit(limit int) int {
	if limit < 1 || limit > 100 {
		return 50
	}
	return limit
}

func (service *Service) queryMessagePage(ctx context.Context, roomID uuid.UUID, queryLimit int, cursor *uuid.UUID) ([]Message, error) {
	rows, err := service.db.Query(ctx, `SELECT m.id, m.room_id, m.sender_user_id, m.sender_guest_session_id, COALESCE(u.display_name, u.email, guest.display_name),
		m.body, m.reply_to_message_id, m.created_at, m.edited_at, m.deleted_at
		FROM room_messages m LEFT JOIN users u ON u.id = m.sender_user_id
		LEFT JOIN room_guest_sessions guest ON guest.id = m.sender_guest_session_id
		WHERE m.room_id = $1
		AND ($3::uuid IS NULL OR (m.created_at, m.id) < (
			SELECT cursor_message.created_at, cursor_message.id
			FROM room_messages cursor_message
			WHERE cursor_message.room_id = $1 AND cursor_message.id = $3
		))
		ORDER BY m.created_at DESC, m.id DESC LIMIT $2`, roomID, queryLimit, cursor)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := make([]Message, 0, queryLimit)
	for rows.Next() {
		message, scanErr := service.scanMessage(ctx, rows)
		if scanErr != nil {
			return nil, scanErr
		}
		messages = append(messages, message)
	}
	return messages, rows.Err()
}

func (service *Service) scanMessage(ctx context.Context, row pgx.Row) (Message, error) {
	var message Message
	err := row.Scan(&message.ID, &message.RoomID, &message.SenderUserID, &message.SenderGuestSessionID, &message.SenderName, &message.Body,
		&message.ReplyToMessageID, &message.CreatedAt, &message.EditedAt, &message.DeletedAt)
	if err != nil {
		return Message{}, err
	}
	message.Body, err = service.decryptMessageBody(ctx, message.ID, message.Body)
	return message, err
}

func (service *Service) decryptMessageBody(ctx context.Context, messageID uuid.UUID, storedBody string) (string, error) {
	if strings.HasPrefix(storedBody, "v1:") {
		return service.cryptor.decrypt(storedBody)
	}
	encryptedBody, err := service.cryptor.encrypt(storedBody)
	if err != nil {
		return "", err
	}
	_, err = service.db.Exec(ctx, `UPDATE room_messages SET body = $1 WHERE id = $2 AND body = $3`, encryptedBody, messageID, storedBody)
	return storedBody, err
}

func (service *Service) loadMessageReactions(ctx context.Context, messages []Message) error {
	if len(messages) == 0 {
		return nil
	}
	indices := make(map[uuid.UUID]int, len(messages))
	ids := make([]uuid.UUID, len(messages))
	for index := range messages {
		messages[index].Reactions = make([]Reaction, 0)
		indices[messages[index].ID] = index
		ids[index] = messages[index].ID
	}
	rows, err := service.db.Query(ctx, `SELECT reaction.message_id, reaction.user_id, reaction.guest_session_id, reaction.emoji,
		COALESCE(account.display_name, account.email, guest.display_name, 'Ukendt bruger')
		FROM room_reactions reaction
		LEFT JOIN users account ON account.id = reaction.user_id
		LEFT JOIN room_guest_sessions guest ON guest.id = reaction.guest_session_id
		WHERE reaction.message_id = ANY($1::uuid[]) ORDER BY reaction.created_at`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var messageID uuid.UUID
		var reaction Reaction
		if err := rows.Scan(&messageID, &reaction.UserID, &reaction.GuestSessionID, &reaction.Emoji, &reaction.DisplayName); err != nil {
			return err
		}
		index := indices[messageID]
		messages[index].Reactions = append(messages[index].Reactions, reaction)
	}
	return rows.Err()
}

func buildMessagePage(messages []Message, limit int) MessagePage {
	page := MessagePage{Messages: messages}
	if len(messages) <= limit {
		return page
	}
	page.Messages = messages[:limit]
	page.NextCursor = page.Messages[len(page.Messages)-1].ID.String()
	return page
}
