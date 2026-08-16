package rooms

import (
	"context"
	"errors"
	"net/mail"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const roomMemberInvitationTTL = 7 * 24 * time.Hour

func (service *Service) UserAccessEnabled(ctx context.Context, userID uuid.UUID) (bool, error) {
	var enabled bool
	err := service.db.QueryRow(ctx, `SELECT rooms_access_enabled FROM users WHERE id=$1 AND is_active=TRUE`, userID).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return enabled, err
}

func (service *Service) InviteMemberByEmail(ctx context.Context, actorID, roomID uuid.UUID, email, role string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	address, err := mail.ParseAddress(email)
	if err != nil || !strings.EqualFold(address.Address, email) {
		return "", ErrMemberNotFound
	}
	if role != RoleModerator && role != RoleMember {
		return "", ErrInvalidRole
	}
	tx, err := service.db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	access, err := loadAccessForUpdate(ctx, tx, roomID, actorID)
	if err != nil {
		return "", err
	}
	if access.archived {
		return "", ErrArchived
	}
	if access.actorRole != RoleOwner && access.actorRole != RoleModerator || access.actorRole == RoleModerator && role == RoleModerator {
		return "", ErrForbidden
	}
	var existing uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM users WHERE lower(email)=lower($1) AND is_active=TRUE`, email).Scan(&existing)
	if err == nil {
		return "", ErrMemberExists
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM invitation_tokens WHERE id IN (
		SELECT invitation_token_id FROM room_member_invitations
		WHERE room_id=$1 AND lower(email)=lower($2) AND accepted_at IS NULL
	)`, roomID, email); err != nil {
		return "", err
	}
	rawToken, tokenHash, err := secureRoomToken()
	if err != nil {
		return "", err
	}
	expiresAt := time.Now().Add(roomMemberInvitationTTL)
	var tokenID uuid.UUID
	if err := tx.QueryRow(ctx, `INSERT INTO invitation_tokens (email, token_hash, created_by, expires_at)
		VALUES ($1,$2,$3,$4) RETURNING id`, email, tokenHash, actorID, expiresAt).Scan(&tokenID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO room_member_invitations
		(invitation_token_id,room_id,email,role,created_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
		tokenID, roomID, email, role, actorID, expiresAt); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return rawToken, nil
}
