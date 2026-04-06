package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const passwordResetTTL = 1 * time.Hour

// PasswordResetService handles request + confirm flows for password resets.
type PasswordResetService struct {
	db     *pgxpool.Pool
	mailer Mailer
}

// Mailer is the minimal interface the auth package needs from the SMTP module.
type Mailer interface {
	SendPasswordReset(ctx context.Context, toEmail, toName, resetLink string) error
	SendInvitation(ctx context.Context, toEmail, inviterName, inviteLink string) error
}

func NewPasswordResetService(db *pgxpool.Pool, mailer Mailer) *PasswordResetService {
	return &PasswordResetService{db: db, mailer: mailer}
}

// GenerateResetToken creates a password-reset token for the given user without
// sending any email. Used by the login flow when must_change_password is set.
func (p *PasswordResetService) GenerateResetToken(ctx context.Context, userID string) (string, error) {
	// Invalidate any existing unused tokens.
	_, _ = p.db.Exec(ctx,
		`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
		userID,
	)

	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("GenerateResetToken: %w", err)
	}
	raw := hex.EncodeToString(b)
	hash := hashToken(raw)

	_, err := p.db.Exec(ctx,
		`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
		userID, hash,
	)
	if err != nil {
		return "", fmt.Errorf("GenerateResetToken: store: %w", err)
	}
	return raw, nil
}

// Request generates a reset token and sends an email if the address is known.
// We deliberately do NOT reveal whether the email exists (timing is best-effort).
func (p *PasswordResetService) Request(ctx context.Context, email, baseURL string) error {
	// Look up user — if not found we silently return
	var userID, displayName string
	err := p.db.QueryRow(ctx,
		`SELECT id, display_name FROM users WHERE email = $1 AND is_active = true`, email,
	).Scan(&userID, &displayName)
	if err != nil {
		return nil // user not found — don't reveal
	}

	// Invalidate any existing tokens for this user
	_, _ = p.db.Exec(ctx,
		`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
		userID,
	)

	// Create new token
	b := make([]byte, tokenBytes)
	if _, err = rand.Read(b); err != nil {
		return fmt.Errorf("password_reset: %w", err)
	}
	raw := hex.EncodeToString(b)
	hash := hashToken(raw)
	expiresAt := time.Now().Add(passwordResetTTL)

	_, err = p.db.Exec(ctx,
		`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
		userID, hash, expiresAt,
	)
	if err != nil {
		return fmt.Errorf("password_reset: store: %w", err)
	}

	resetLink := baseURL + "/reset-password?token=" + raw
	if p.mailer != nil {
		_ = p.mailer.SendPasswordReset(ctx, email, displayName, resetLink)
	}
	return nil
}

// Confirm validates the token and updates the user's password hash.
// newPasswordHash must already be an Argon2id hash — callers must hash first.
func (p *PasswordResetService) Confirm(ctx context.Context, rawToken, newPasswordHash string) error {
	hash := hashToken(rawToken)

	var tokenID, userID string
	err := p.db.QueryRow(ctx,
		`SELECT id, user_id FROM password_reset_tokens
		 WHERE token_hash = $1
		   AND used_at IS NULL
		   AND expires_at > now()`,
		hash,
	).Scan(&tokenID, &userID)
	if err != nil {
		return fmt.Errorf("password_reset: invalid or expired token")
	}

	tx, err := p.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Update password and clear force-reset flag
	if _, err = tx.Exec(ctx,
		`UPDATE users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2`,
		newPasswordHash, userID,
	); err != nil {
		return fmt.Errorf("password_reset: update password: %w", err)
	}

	// Mark token used
	if _, err = tx.Exec(ctx,
		`UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`, tokenID,
	); err != nil {
		return fmt.Errorf("password_reset: mark used: %w", err)
	}

	// Revoke all existing sessions (force re-login)
	if _, err = tx.Exec(ctx,
		`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, userID,
	); err != nil {
		return fmt.Errorf("password_reset: revoke sessions: %w", err)
	}

	return tx.Commit(ctx)
}
