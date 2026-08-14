package rooms

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yourname/privatedrive/internal/audit"
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
	db    *pgxpool.Pool
	audit audit.Logger
}

type roomAccess struct {
	ownerID        uuid.UUID
	managedGroupID uuid.UUID
	archived       bool
	actorRole      string
}

func NewService(db *pgxpool.Pool, auditLogger audit.Logger) *Service {
	return &Service{db: db, audit: auditLogger}
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
	rows, err := service.db.Query(ctx, `SELECT `+roomColumns+`, rm.role
		FROM rooms r
		JOIN room_members rm ON rm.room_id = r.id
		WHERE rm.user_id = $1 AND ($2 OR r.archived_at IS NULL)
		ORDER BY r.updated_at DESC, r.id DESC`, actorID, includeArchived)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make([]Room, 0)
	for rows.Next() {
		room, err := scanRoomWithRole(rows)
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
		SELECT 1 FROM users WHERE id = $1 AND is_active = TRUE AND role <> 'guest')`, userID).Scan(&activeUser); err != nil {
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

func (service *Service) AddMemberByEmail(ctx context.Context, actorID, roomID uuid.UUID, email, role string) error {
	var userID uuid.UUID
	err := service.db.QueryRow(ctx, `SELECT id FROM users
		WHERE email = lower($1) AND is_active = TRUE AND role <> 'guest'`, strings.TrimSpace(email)).Scan(&userID)
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
