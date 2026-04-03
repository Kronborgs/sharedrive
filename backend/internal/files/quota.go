package files

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// QuotaManager tracks and enforces per-user storage quota.
type QuotaManager struct {
	db *pgxpool.Pool
}

// NewQuotaManager creates a QuotaManager.
func NewQuotaManager(db *pgxpool.Pool) *QuotaManager {
	return &QuotaManager{db: db}
}

// Check returns an error if the user does not have enough quota to add addBytes.
func (q *QuotaManager) Check(ctx context.Context, userID string, addBytes int64) error {
	var quotaBytes, usedBytes int64
	if err := q.db.QueryRow(ctx,
		`SELECT quota_bytes, quota_used_bytes FROM users WHERE id = $1`, userID,
	).Scan(&quotaBytes, &usedBytes); err != nil {
		return fmt.Errorf("quota: user not found")
	}
	if usedBytes+addBytes > quotaBytes {
		return fmt.Errorf("quota: insufficient space (%d bytes available)", quotaBytes-usedBytes)
	}
	return nil
}

// Add atomically increments quota_used_bytes by delta (may be negative for deletes).
// It never reduces quota_used_bytes below zero.
func (q *QuotaManager) Add(ctx context.Context, userID string, delta int64) error {
	_, err := q.db.Exec(ctx,
		`UPDATE users
		 SET quota_used_bytes = GREATEST(0, quota_used_bytes + $1),
		     updated_at = now()
		 WHERE id = $2`,
		delta, userID,
	)
	return err
}

// Used returns the current quota_used_bytes for a user.
func (q *QuotaManager) Used(ctx context.Context, userID string) (int64, error) {
	var used int64
	if err := q.db.QueryRow(ctx,
		`SELECT quota_used_bytes FROM users WHERE id = $1`, userID,
	).Scan(&used); err != nil {
		return 0, fmt.Errorf("quota: user not found")
	}
	return used, nil
}

// Recalculate recomputes quota_used_bytes from scratch (non-deleted files).
// Safe to run periodically to correct drift.
func (q *QuotaManager) Recalculate(ctx context.Context, userID string) error {
	_, err := q.db.Exec(ctx,
		`UPDATE users u
		 SET quota_used_bytes = COALESCE((
		       SELECT sum(size_bytes)
		       FROM files
		       WHERE owner_id = u.id AND deleted_at IS NULL AND is_folder = false
		     ), 0),
		     updated_at = now()
		 WHERE u.id = $1`,
		userID,
	)
	return err
}
