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

// GroupForMail preserves the source membership and creates a separate stream
// when visible mail recipients are not already participants.
func (service *Service) GroupForMail(ctx context.Context, actorID, sourceID uuid.UUID, addresses []string) (groupEmailResult, error) {
	tx, err := service.db.Begin(ctx)
	if err != nil {
		return groupEmailResult{}, err
	}
	defer tx.Rollback(ctx)
	var roomID *uuid.UUID
	var sourceName string
	err = tx.QueryRow(ctx, `SELECT c.source_room_id, COALESCE(NULLIF(c.name,''),'Chatgruppe') FROM direct_conversations c JOIN direct_conversation_members m ON m.conversation_id=c.id AND m.user_id=$1 WHERE c.id=$2`, actorID, sourceID).Scan(&roomID, &sourceName)
	if errors.Is(err, pgx.ErrNoRows) {
		return groupEmailResult{}, ErrNotFound
	}
	if err != nil {
		return groupEmailResult{}, err
	}
	rows, err := tx.Query(ctx, `SELECT user_id FROM direct_conversation_members WHERE conversation_id=$1`, sourceID)
	if err != nil {
		return groupEmailResult{}, err
	}
	members := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return groupEmailResult{}, err
		}
		members = append(members, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return groupEmailResult{}, err
	}
	existing := map[uuid.UUID]bool{}
	for _, id := range members {
		existing[id] = true
	}
	pending := map[string]bool{}
	rows, err = tx.Query(ctx, `SELECT lower(email) FROM direct_chat_invitations WHERE conversation_id=$1 AND accepted_at IS NULL AND expires_at>now()`, sourceID)
	if err != nil {
		return groupEmailResult{}, err
	}
	for rows.Next() {
		var email string
		if err = rows.Scan(&email); err != nil {
			rows.Close()
			return groupEmailResult{}, err
		}
		pending[email] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return groupEmailResult{}, err
	}
	missing := false
	for _, raw := range addresses {
		address, parseErr := mail.ParseAddress(strings.TrimSpace(raw))
		if parseErr != nil {
			return groupEmailResult{}, ErrInvalidName
		}
		email, parseErr := validateDirectChatEmail(address.Address)
		if parseErr != nil {
			return groupEmailResult{}, parseErr
		}
		var id uuid.UUID
		var active, enabled bool
		lookupErr := tx.QueryRow(ctx, `SELECT id,is_active,rooms_access_enabled FROM users WHERE lower(email)=lower($1)`, email).Scan(&id, &active, &enabled)
		if errors.Is(lookupErr, pgx.ErrNoRows) {
			if !pending[email] {
				pending[email] = true
				missing = true
			}
			continue
		}
		if lookupErr != nil {
			return groupEmailResult{}, lookupErr
		}
		if !active || !enabled {
			return groupEmailResult{}, ErrForbidden
		}
		if !existing[id] {
			existing[id] = true
			members = append(members, id)
			missing = true
		}
	}
	if !missing {
		if err = tx.Commit(ctx); err != nil {
			return groupEmailResult{}, err
		}
		c, e := service.directConversationForActor(ctx, actorID, sourceID)
		return groupEmailResult{Conversation: c}, e
	}
	if len(members) < 2 {
		return groupEmailResult{}, ErrInvalidName
	}
	name, err := NormalizeName(sourceName)
	if err != nil {
		return groupEmailResult{}, err
	}
	groupID, err := insertGroupConversation(ctx, tx, actorID, roomID, name, members)
	if err != nil {
		return groupEmailResult{}, err
	}
	result := groupEmailResult{}
	for email := range pending {
		raw, hash, tokenErr := secureRoomToken()
		if tokenErr != nil {
			return groupEmailResult{}, tokenErr
		}
		expiry := time.Now().Add(roomMemberInvitationTTL)
		var tokenID uuid.UUID
		err = tx.QueryRow(ctx, `INSERT INTO invitation_tokens(email,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4) RETURNING id`, email, hash, actorID, expiry).Scan(&tokenID)
		if err != nil {
			return groupEmailResult{}, err
		}
		_, err = tx.Exec(ctx, `INSERT INTO direct_chat_invitations(invitation_token_id,inviter_user_id,email,expires_at,conversation_id) VALUES($1,$2,$3,$4,$5)`, tokenID, actorID, email, expiry, groupID)
		if err != nil {
			return groupEmailResult{}, err
		}
		result.Invitations = append(result.Invitations, groupEmailInvitation{email, raw})
	}
	if err = tx.Commit(ctx); err != nil {
		return groupEmailResult{}, err
	}
	result.Conversation, err = service.directConversationForActor(ctx, actorID, groupID)
	return result, err
}
