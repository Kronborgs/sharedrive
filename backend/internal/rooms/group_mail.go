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

type groupEmailInvitation struct{ Email, Token string }
type groupEmailResult struct {
	Conversation DirectConversation
	Invitations  []groupEmailInvitation
}
type mailGroupMembers struct {
	members  []uuid.UUID
	existing map[uuid.UUID]bool
	pending  map[string]bool
}

// GroupForMail preserves the source membership and creates a separate stream
// when visible mail recipients are not already participants.
func (service *Service) GroupForMail(ctx context.Context, actorID, sourceID uuid.UUID, addresses []string) (groupEmailResult, error) {
	tx, err := service.db.Begin(ctx)
	if err != nil {
		return groupEmailResult{}, err
	}
	defer tx.Rollback(ctx)
	roomID, sourceName, err := mailGroupSource(ctx, tx, actorID, sourceID)
	if err != nil {
		return groupEmailResult{}, err
	}
	members, err := loadMailGroupMembers(ctx, tx, sourceID)
	if err != nil {
		return groupEmailResult{}, err
	}
	missing, err := members.addRecipients(ctx, tx, addresses)
	if err != nil {
		return groupEmailResult{}, err
	}
	if !missing {
		if err = tx.Commit(ctx); err != nil {
			return groupEmailResult{}, err
		}
		conversation, err := service.directConversationForActor(ctx, actorID, sourceID)
		return groupEmailResult{Conversation: conversation}, err
	}
	if len(members.members) < 2 {
		return groupEmailResult{}, ErrInvalidName
	}
	name, err := NormalizeName(sourceName)
	if err != nil {
		return groupEmailResult{}, err
	}
	groupID, err := insertGroupConversation(ctx, tx, actorID, roomID, name, members.members)
	if err != nil {
		return groupEmailResult{}, err
	}
	invitations, err := createMailGroupInvitations(ctx, tx, actorID, groupID, members.pending)
	if err != nil {
		return groupEmailResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return groupEmailResult{}, err
	}
	conversation, err := service.directConversationForActor(ctx, actorID, groupID)
	return groupEmailResult{Conversation: conversation, Invitations: invitations}, err
}

func mailGroupSource(ctx context.Context, tx pgx.Tx, actorID, sourceID uuid.UUID) (*uuid.UUID, string, error) {
	var roomID *uuid.UUID
	var name string
	err := tx.QueryRow(ctx, `SELECT c.source_room_id, COALESCE(NULLIF(c.name,''),'Chatgruppe') FROM direct_conversations c JOIN direct_conversation_members m ON m.conversation_id=c.id AND m.user_id=$1 WHERE c.id=$2`, actorID, sourceID).Scan(&roomID, &name)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", ErrNotFound
	}
	return roomID, name, err
}

func loadMailGroupMembers(ctx context.Context, tx pgx.Tx, sourceID uuid.UUID) (mailGroupMembers, error) {
	result := mailGroupMembers{members: []uuid.UUID{}, existing: map[uuid.UUID]bool{}, pending: map[string]bool{}}
	rows, err := tx.Query(ctx, `SELECT user_id FROM direct_conversation_members WHERE conversation_id=$1`, sourceID)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return result, err
		}
		result.members = append(result.members, id)
		result.existing[id] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = tx.Query(ctx, `SELECT lower(email) FROM direct_chat_invitations WHERE conversation_id=$1 AND accepted_at IS NULL AND expires_at>now()`, sourceID)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var email string
		if err = rows.Scan(&email); err != nil {
			return result, err
		}
		result.pending[email] = true
	}
	return result, rows.Err()
}

func (members *mailGroupMembers) addRecipients(ctx context.Context, tx pgx.Tx, addresses []string) (bool, error) {
	missing := false
	for _, raw := range addresses {
		added, err := members.addRecipient(ctx, tx, raw)
		if err != nil {
			return false, err
		}
		missing = missing || added
	}
	return missing, nil
}

func (members *mailGroupMembers) addRecipient(ctx context.Context, tx pgx.Tx, raw string) (bool, error) {
	address, err := mail.ParseAddress(strings.TrimSpace(raw))
	if err != nil {
		return false, ErrInvalidName
	}
	email, err := validateDirectChatEmail(address.Address)
	if err != nil {
		return false, err
	}
	var id uuid.UUID
	var active, enabled bool
	err = tx.QueryRow(ctx, `SELECT id,is_active,rooms_access_enabled FROM users WHERE lower(email)=lower($1)`, email).Scan(&id, &active, &enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		if members.pending[email] {
			return false, nil
		}
		members.pending[email] = true
		return true, nil
	}
	if err != nil {
		return false, err
	}
	if !active || !enabled {
		return false, ErrForbidden
	}
	if members.existing[id] {
		return false, nil
	}
	members.existing[id] = true
	members.members = append(members.members, id)
	return true, nil
}

func createMailGroupInvitations(ctx context.Context, tx pgx.Tx, actorID, groupID uuid.UUID, pending map[string]bool) ([]groupEmailInvitation, error) {
	var invitations []groupEmailInvitation
	for email := range pending {
		raw, hash, err := secureRoomToken()
		if err != nil {
			return nil, err
		}
		expiry := time.Now().Add(roomMemberInvitationTTL)
		var tokenID uuid.UUID
		err = tx.QueryRow(ctx, `INSERT INTO invitation_tokens(email,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4) RETURNING id`, email, hash, actorID, expiry).Scan(&tokenID)
		if err != nil {
			return nil, err
		}
		_, err = tx.Exec(ctx, `INSERT INTO direct_chat_invitations(invitation_token_id,inviter_user_id,email,expires_at,conversation_id) VALUES($1,$2,$3,$4,$5)`, tokenID, actorID, email, expiry, groupID)
		if err != nil {
			return nil, err
		}
		invitations = append(invitations, groupEmailInvitation{email, raw})
	}
	return invitations, nil
}
