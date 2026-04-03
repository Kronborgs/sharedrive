package auth

import (
	"context"
	"fmt"
	"net"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// LockoutTier describes a progressive lockout level.
type LockoutTier struct {
	Threshold int           // consecutive failures to trigger
	Duration  time.Duration // lockout length
}

// DefaultTiers are the three built-in lockout levels.
var DefaultTiers = []LockoutTier{
	{Threshold: 5, Duration: 60 * time.Minute},
	{Threshold: 10, Duration: 6 * time.Hour},
	{Threshold: 20, Duration: 24 * time.Hour},
}

// Lockout manages IP-based lockouts on top of the rate limiter.
type Lockout struct {
	rdb   *redis.Client
	db    *pgxpool.Pool
	tiers []LockoutTier
}

func NewLockout(rdb *redis.Client, db *pgxpool.Pool, tiers []LockoutTier) *Lockout {
	if len(tiers) == 0 {
		tiers = DefaultTiers
	}
	return &Lockout{rdb: rdb, db: db, tiers: tiers}
}

const lockoutKeyPrefix = "lockout:"

// IsLocked returns true if the IP is currently locked out.
func (l *Lockout) IsLocked(ctx context.Context, ip string) (bool, time.Duration, error) {
	// Check manual admin block first (stored in DB)
	if blocked, err := l.isManuallyBlocked(ctx, ip); err != nil {
		return false, 0, err
	} else if blocked {
		return true, 0, nil // permanent / manual
	}

	// Check Redis TTL-based lockout
	key := lockoutKeyPrefix + ip
	ttl, err := l.rdb.TTL(ctx, key).Result()
	if err != nil && err != redis.Nil {
		return false, 0, fmt.Errorf("lockout check: %w", err)
	}
	if ttl > 0 {
		return true, ttl, nil
	}
	return false, 0, nil
}

// RecordFailure increments the failure counter for an IP and applies a lockout
// if a tier threshold is met. Returns (locked bool, lockoutDuration, error).
func (l *Lockout) RecordFailure(ctx context.Context, ip string) (bool, time.Duration, error) {
	key := lockoutKeyPrefix + "failures:" + ip

	// Atomic increment with 24h expiry (reset window)
	count, err := l.rdb.Incr(ctx, key).Result()
	if err != nil {
		return false, 0, fmt.Errorf("lockout record: %w", err)
	}
	l.rdb.Expire(ctx, key, 24*time.Hour)

	// Check tiers from most severe to least
	for i := len(l.tiers) - 1; i >= 0; i-- {
		tier := l.tiers[i]
		if int(count) >= tier.Threshold {
			lockKey := lockoutKeyPrefix + ip
			l.rdb.Set(ctx, lockKey, "1", tier.Duration)
			return true, tier.Duration, nil
		}
	}
	return false, 0, nil
}

// ClearFailures resets the failure counter for an IP (called on successful login).
func (l *Lockout) ClearFailures(ctx context.Context, ip string) error {
	return l.rdb.Del(ctx, lockoutKeyPrefix+"failures:"+ip).Err()
}

// ManualBlock writes a permanent block to the ip_whitelist/blocked_ips table.
func (l *Lockout) ManualBlock(ctx context.Context, ip string, adminUserID string) error {
	_, err := l.db.Exec(ctx,
		`INSERT INTO ip_whitelist (ip_cidr, description, created_by)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (ip_cidr) DO NOTHING`,
		ip+"/32",
		"Manually blocked by admin",
		adminUserID,
	)
	// Also set an indefinite Redis key so the check is fast
	l.rdb.Set(ctx, lockoutKeyPrefix+ip, "manual", 0) // 0 = no expiry
	return err
}

// Unblock removes a temporary or manual block.
func (l *Lockout) Unblock(ctx context.Context, ip string) error {
	l.rdb.Del(ctx, lockoutKeyPrefix+ip)
	l.rdb.Del(ctx, lockoutKeyPrefix+"failures:"+ip)
	_, err := l.db.Exec(ctx,
		`DELETE FROM ip_whitelist WHERE ip_cidr = $1 AND description = 'Manually blocked by admin'`,
		ip+"/32",
	)
	return err
}

// IsWhitelisted returns true if the IP matches any entry in the ip_whitelist table.
func (l *Lockout) IsWhitelisted(ctx context.Context, ip string) (bool, error) {
	rows, err := l.db.Query(ctx, `SELECT ip_cidr FROM ip_whitelist`)
	if err != nil {
		return false, err
	}
	defer rows.Close()

	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false, nil
	}

	for rows.Next() {
		var cidr string
		if err := rows.Scan(&cidr); err != nil {
			continue
		}
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		if network.Contains(parsed) {
			return true, nil
		}
	}
	return false, rows.Err()
}

func (l *Lockout) isManuallyBlocked(ctx context.Context, ip string) (bool, error) {
	val, err := l.rdb.Get(ctx, lockoutKeyPrefix+ip).Result()
	if err == redis.Nil {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return val == "manual", nil
}
