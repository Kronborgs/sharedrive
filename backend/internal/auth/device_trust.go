package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const deviceTrustTokenBytes = 32

// DeviceTrustService manages trusted-device tokens that allow users to skip
// TOTP on subsequent logins from the same browser/device.
type DeviceTrustService struct {
	db     *pgxpool.Pool
	secret []byte
}

// NewDeviceTrustService creates a DeviceTrustService.
// secret must be a non-empty, high-entropy value from configuration.
// It is used to HMAC device trust tokens so that they cannot be forged
// without knowledge of the secret even if the token_hash column is exposed.
func NewDeviceTrustService(db *pgxpool.Pool, secret string) (*DeviceTrustService, error) {
	if secret == "" {
		return nil, fmt.Errorf("device trust: DEVICE_TRUST_SECRET must not be empty")
	}
	return &DeviceTrustService{db: db, secret: []byte(secret)}, nil
}

// tokenHash returns the HMAC-SHA256 of raw using the service secret.
func (s *DeviceTrustService) tokenHash(raw string) string {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(raw))
	return hex.EncodeToString(mac.Sum(nil))
}

// Issue generates a new device trust token, persists its HMAC hash, and
// returns the raw cookie-ready value. The token is valid for 30 days.
func (s *DeviceTrustService) Issue(ctx context.Context, userID, ip, userAgent string) (string, error) {
	b := make([]byte, deviceTrustTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("device trust: generate token: %w", err)
	}
	raw := hex.EncodeToString(b)
	hash := s.tokenHash(raw)

	_, err := s.db.Exec(ctx,
		`INSERT INTO device_trust_tokens
		        (user_id, token_hash, ip_address, user_agent, expires_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		userID, hash, ip, userAgent,
		time.Now().Add(30*24*time.Hour),
	)
	if err != nil {
		return "", fmt.Errorf("device trust: store token: %w", err)
	}
	return raw, nil
}

// Validate checks a raw device-trust cookie value against the database.
// Returns the ownerID (user UUID string) if the token is valid and unexpired.
func (s *DeviceTrustService) Validate(ctx context.Context, raw string) (string, error) {
	hash := s.tokenHash(raw)

	var userID string
	err := s.db.QueryRow(ctx,
		`SELECT user_id::TEXT
		 FROM device_trust_tokens
		 WHERE token_hash = $1
		   AND revoked_at IS NULL
		   AND expires_at > now()`,
		hash,
	).Scan(&userID)
	if err != nil {
		return "", fmt.Errorf("device trust: invalid or expired token")
	}

	// Best-effort: update last_used_at for audit purposes.
	_, _ = s.db.Exec(ctx,
		`UPDATE device_trust_tokens SET last_used_at = now() WHERE token_hash = $1`,
		hash,
	)
	return userID, nil
}
