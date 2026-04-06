package user

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// FindByID returns a user by primary key, or nil if not found.
func FindByID(ctx context.Context, db *pgxpool.Pool, id string) (*User, error) {
	const q = `
		SELECT id, email, display_name, password_hash, role, is_active,
		       quota_bytes, quota_used_bytes, bandwidth_limit_bytes_per_day,
		       webdav_enabled, trash_retention_days, invited_by, last_login_at,
		       created_at, updated_at
		FROM users
		WHERE id = $1`

	u := &User{}
	err := db.QueryRow(ctx, q, id).Scan(
		&u.ID, &u.Email, &u.DisplayName, &u.PasswordHash,
		&u.Role, &u.IsActive,
		&u.QuotaBytes, &u.QuotaUsedBytes, &u.BandwidthLimitBytesPerDay,
		&u.WebDAVEnabled, &u.TrashRetentionDays, &u.InvitedBy, &u.LastLoginAt,
		&u.CreatedAt, &u.UpdatedAt,
	)
	if err != nil {
		return nil, nil // not found
	}
	return u, nil
}

// FindByEmail returns a user by email (case-insensitive), or nil if not found.
func FindByEmail(ctx context.Context, db *pgxpool.Pool, email string) (*User, error) {
	const q = `
		SELECT id, email, display_name, password_hash, role, is_active,
		       quota_bytes, quota_used_bytes, bandwidth_limit_bytes_per_day,
		       webdav_enabled, trash_retention_days, invited_by, last_login_at,
		       created_at, updated_at
		FROM users
		WHERE lower(email) = lower($1)`

	u := &User{}
	err := db.QueryRow(ctx, q, email).Scan(
		&u.ID, &u.Email, &u.DisplayName, &u.PasswordHash,
		&u.Role, &u.IsActive,
		&u.QuotaBytes, &u.QuotaUsedBytes, &u.BandwidthLimitBytesPerDay,
		&u.WebDAVEnabled, &u.TrashRetentionDays, &u.InvitedBy, &u.LastLoginAt,
		&u.CreatedAt, &u.UpdatedAt,
	)
	if err != nil {
		return nil, nil
	}
	return u, nil
}

// List returns all users ordered by created_at desc with optional active-only filter.
func List(ctx context.Context, db *pgxpool.Pool, limit, offset int, activeOnly bool) ([]*User, int, error) {
	var countQ string
	var countArgs []interface{}
	if activeOnly {
		countQ = `SELECT count(*) FROM users WHERE is_active = true`
	} else {
		countQ = `SELECT count(*) FROM users WHERE role != 'guest'`
	}
	var total int
	if err := db.QueryRow(ctx, countQ, countArgs...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("user.List count: %w", err)
	}

	var q string
	var args []interface{}
	const cols = `id, email, display_name, password_hash, role, is_active,
	              quota_bytes, quota_used_bytes, bandwidth_limit_bytes_per_day,
	              webdav_enabled, trash_retention_days, invited_by, last_login_at, created_at, updated_at`
	if activeOnly {
		q = `SELECT ` + cols + ` FROM users WHERE is_active = true ORDER BY created_at DESC LIMIT $1 OFFSET $2`
	} else {
		q = `SELECT ` + cols + ` FROM users WHERE role != 'guest' ORDER BY created_at DESC LIMIT $1 OFFSET $2`
	}
	args = []interface{}{limit, offset}

	rows, err := db.Query(ctx, q, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("user.List: %w", err)
	}
	defer rows.Close()

	var users []*User
	for rows.Next() {
		u := &User{}
		if err := rows.Scan(
			&u.ID, &u.Email, &u.DisplayName, &u.PasswordHash,
			&u.Role, &u.IsActive,
			&u.QuotaBytes, &u.QuotaUsedBytes, &u.BandwidthLimitBytesPerDay,
			&u.WebDAVEnabled, &u.TrashRetentionDays, &u.InvitedBy, &u.LastLoginAt,
			&u.CreatedAt, &u.UpdatedAt,
		); err != nil {
			return nil, 0, err
		}
		users = append(users, u)
	}
	return users, total, rows.Err()
}
