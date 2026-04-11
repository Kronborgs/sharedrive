package backup

import (
	"context"
	"fmt"
	"time"

	"github.com/alexedwards/argon2id"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// PasswordService manages per-user backup passwords.
//
// It handles token generation, Argon2id hashing, wrapped-key storage,
// verification, and revocation — independent of any HTTP concerns.
// All methods accept a context so callers control timeouts and cancellation.
type PasswordService struct {
	db      *pgxpool.Pool
	wrapKey string // BACKUP_WRAP_KEY hex — may be empty
}

// NewPasswordService creates a PasswordService.
func NewPasswordService(db *pgxpool.Pool, wrapKey string) *PasswordService {
	return &PasswordService{db: db, wrapKey: wrapKey}
}

// Status returns the active backup-password record for userID.
// Returns BackupPasswordStatus{HasPassword: false} when none exists.
func (s *PasswordService) Status(ctx context.Context, userID uuid.UUID) (*BackupPasswordStatus, error) {
	var id string
	var lastUsed *time.Time
	var createdAt time.Time

	err := s.db.QueryRow(ctx,
		`SELECT id, last_used_at, created_at
		 FROM backup_passwords
		 WHERE user_id = $1 AND revoked_at IS NULL
		 ORDER BY created_at DESC LIMIT 1`,
		userID,
	).Scan(&id, &lastUsed, &createdAt)

	if err == pgx.ErrNoRows {
		return &BackupPasswordStatus{HasPassword: false}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("password: status: %w", err)
	}
	return &BackupPasswordStatus{
		HasPassword: true,
		ID:          &id,
		LastUsedAt:  lastUsed,
		CreatedAt:   &createdAt,
	}, nil
}

// Generate creates a new backup token, revoking any existing active one in
// the same transaction. Returns the new record ID and the raw token.
// The raw token is returned exactly once — it is not stored.
func (s *PasswordService) Generate(ctx context.Context, userID uuid.UUID) (id, token string, err error) {
	token, err = generateRawToken()
	if err != nil {
		return "", "", fmt.Errorf("password: generate token: %w", err)
	}

	hash, err := argon2id.CreateHash(token, argon2id.DefaultParams)
	if err != nil {
		return "", "", fmt.Errorf("password: hash token: %w", err)
	}

	// Optionally wrap the raw token so scheduled exports can use it later.
	// The token itself is the ZIP password, so we store it encrypted.
	wrappedKey, err := WrapKey([]byte(token), s.wrapKey)
	if err != nil {
		log.Warn().Err(err).Msg("backup: wrap key failed — storing without wrapped key")
		wrappedKey = nil
	}

	tx, txErr := s.db.Begin(ctx)
	if txErr != nil {
		return "", "", fmt.Errorf("password: begin tx: %w", txErr)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx,
		`UPDATE backup_passwords SET revoked_at = NOW()
		 WHERE user_id = $1 AND revoked_at IS NULL`,
		userID,
	); err != nil {
		return "", "", fmt.Errorf("password: revoke old: %w", err)
	}

	if err := tx.QueryRow(ctx,
		`INSERT INTO backup_passwords (user_id, password_hash, wrapped_key)
		 VALUES ($1, $2, $3) RETURNING id`,
		userID, hash, wrappedKey,
	).Scan(&id); err != nil {
		return "", "", fmt.Errorf("password: insert: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", "", fmt.Errorf("password: commit: %w", err)
	}
	return id, token, nil
}

// Revoke marks the active backup password for userID as revoked.
// Returns (false, nil) when no active password exists.
func (s *PasswordService) Revoke(ctx context.Context, userID uuid.UUID) (bool, error) {
	tag, err := s.db.Exec(ctx,
		`UPDATE backup_passwords SET revoked_at = NOW()
		 WHERE user_id = $1 AND revoked_at IS NULL`,
		userID,
	)
	if err != nil {
		return false, fmt.Errorf("password: revoke: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

// Verify returns true when rawToken matches the active Argon2id hash for
// userID. This is intentionally slow — do not call in hot paths.
func (s *PasswordService) Verify(ctx context.Context, userID uuid.UUID, rawToken string) bool {
	var hash string
	err := s.db.QueryRow(ctx,
		`SELECT password_hash
		 FROM backup_passwords
		 WHERE user_id = $1 AND revoked_at IS NULL
		 ORDER BY created_at DESC LIMIT 1`,
		userID,
	).Scan(&hash)
	if err != nil {
		return false
	}
	match, err := argon2id.ComparePasswordAndHash(rawToken, hash)
	return err == nil && match
}

// TouchLastUsed updates last_used_at for the active backup password.
// Errors are silently discarded — this is best-effort bookkeeping.
func (s *PasswordService) TouchLastUsed(ctx context.Context, userID uuid.UUID) {
	_, _ = s.db.Exec(ctx,
		`UPDATE backup_passwords SET last_used_at = NOW()
		 WHERE user_id = $1 AND revoked_at IS NULL`,
		userID,
	)
}
