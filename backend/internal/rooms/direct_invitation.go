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

type DirectChatInviteResult struct {
	Conversation *DirectConversation
	Token        string
}

func validateDirectChatEmail(email string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(email))
	address, err := mail.ParseAddress(normalized)
	if err != nil || !strings.EqualFold(address.Address, normalized) {
		return "", ErrInvalidName
	}
	return normalized, nil
}

// StartPrivateChatByEmail opens a chat immediately for an active Chat user.
// For a new address it stores a one-time account invitation instead; accepting
// that invitation creates the private chat without exposing Sharedrive files.
func (service *Service) StartPrivateChatByEmail(ctx context.Context, actorID uuid.UUID, email string) (DirectChatInviteResult, error) {
	email, err := validateDirectChatEmail(email)
	if err != nil {
		return DirectChatInviteResult{}, err
	}
	var userID uuid.UUID
	err = service.db.QueryRow(ctx, `SELECT id FROM users WHERE lower(email)=lower($1) AND is_active=TRUE`, email).Scan(&userID)
	if err == nil {
		conversation, conversationErr := service.CreateDirectConversationForContact(ctx, actorID, userID)
		return DirectChatInviteResult{Conversation: &conversation}, conversationErr
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return DirectChatInviteResult{}, err
	}

	tx, err := service.db.Begin(ctx)
	if err != nil {
		return DirectChatInviteResult{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `DELETE FROM invitation_tokens WHERE id IN (
		SELECT invitation_token_id FROM direct_chat_invitations
		WHERE inviter_user_id=$1 AND lower(email)=lower($2) AND accepted_at IS NULL)`, actorID, email); err != nil {
		return DirectChatInviteResult{}, err
	}
	rawToken, tokenHash, err := secureRoomToken()
	if err != nil {
		return DirectChatInviteResult{}, err
	}
	expiresAt := time.Now().Add(roomMemberInvitationTTL)
	var tokenID uuid.UUID
	if err = tx.QueryRow(ctx, `INSERT INTO invitation_tokens(email,token_hash,created_by,expires_at)
		VALUES($1,$2,$3,$4) RETURNING id`, email, tokenHash, actorID, expiresAt).Scan(&tokenID); err != nil {
		return DirectChatInviteResult{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO direct_chat_invitations(invitation_token_id,inviter_user_id,email,expires_at)
		VALUES($1,$2,$3,$4)`, tokenID, actorID, email, expiresAt); err != nil {
		return DirectChatInviteResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return DirectChatInviteResult{}, err
	}
	return DirectChatInviteResult{Token: rawToken}, nil
}
