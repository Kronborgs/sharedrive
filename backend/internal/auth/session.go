package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const tokenBytes = 32

// Session represents a row in the sessions table.
type Session struct {
	ID        string
	UserID    string
	TokenHash string
	IPAddress string
	UserAgent string
	ExpiresAt time.Time
	CreatedAt time.Time
}

// Create issues a new opaque session token for the given user and returns the
// raw token (sent to client as a cookie) and the stored Session.
func CreateSession(ctx context.Context, db *pgxpool.Pool, userID, ip, ua string, ttl time.Duration) (rawToken string, s Session, err error) {
	b := make([]byte, tokenBytes)
	if _, err = rand.Read(b); err != nil {
		return "", Session{}, fmt.Errorf("auth: generate token: %w", err)
	}
	rawToken = hex.EncodeToString(b)
	hash := hashToken(rawToken)

	s = Session{
		UserID:    userID,
		TokenHash: hash,
		IPAddress: ip,
		UserAgent: ua,
		ExpiresAt: time.Now().Add(ttl),
	}

	const q = `
		INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, created_at`

	row := db.QueryRow(ctx, q, s.UserID, s.TokenHash, s.IPAddress, s.UserAgent, s.ExpiresAt)
	if err = row.Scan(&s.ID, &s.CreatedAt); err != nil {
		return "", Session{}, fmt.Errorf("auth: insert session: %w", err)
	}
	return rawToken, s, nil
}

// Validate looks up a raw token and returns the session if it is valid
// (not revoked, not expired). It also performs a sliding-window expiry bump
// when idleTTL > 0.
func ValidateSession(ctx context.Context, db *pgxpool.Pool, rawToken string, idleTTL time.Duration) (*Session, error) {
	hash := hashToken(rawToken)

	const q = `
		SELECT id, user_id, token_hash, ip_address, user_agent, expires_at, created_at
		FROM sessions
		WHERE token_hash = $1
		  AND revoked_at IS NULL
		  AND expires_at > now()`

	row := db.QueryRow(ctx, q, hash)
	var s Session
	if err := row.Scan(&s.ID, &s.UserID, &s.TokenHash, &s.IPAddress, &s.UserAgent, &s.ExpiresAt, &s.CreatedAt); err != nil {
		return nil, fmt.Errorf("auth: session not found or expired")
	}

	// Slide expiry window
	if idleTTL > 0 {
		newExpiry := time.Now().Add(idleTTL)
		_, _ = db.Exec(ctx, `UPDATE sessions SET expires_at = $1 WHERE id = $2`, newExpiry, s.ID)
		s.ExpiresAt = newExpiry
	}

	return &s, nil
}

// Revoke marks a session as revoked by its raw token.
func RevokeSession(ctx context.Context, db *pgxpool.Pool, rawToken string) error {
	hash := hashToken(rawToken)
	_, err := db.Exec(ctx, `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1`, hash)
	return err
}

// RevokeAllUserSessions revokes all active sessions for a user (e.g. on password change).
func RevokeAllUserSessions(ctx context.Context, db *pgxpool.Pool, userID string) error {
	_, err := db.Exec(ctx,
		`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
		userID,
	)
	return err
}

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}
