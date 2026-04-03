package auth

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// RateLimiter implements a sliding-window counter using a Redis sorted set.
// Each attempt is stored as a member with score = unix timestamp (ms).
// The window is trimmed on every check so memory stays bounded.
type RateLimiter struct {
	rdb    *redis.Client
	prefix string
}

// NewRateLimiter creates a limiter. prefix is prepended to all Redis keys.
func NewRateLimiter(rdb *redis.Client) *RateLimiter {
	return &RateLimiter{rdb: rdb, prefix: "rl:"}
}

// Key types used in the application.
const (
	KeyIPLogin         = "ip_login:"
	KeyUserLogin       = "user_login:"
	KeyIPGlobal        = "ip_global:"
	KeyIPPasswordReset = "ip_pwreset:"
	KeyIPInviteAccept  = "ip_invite:"
)

// Allow checks whether the key is within limit attempts per window.
// It also records the current attempt (i.e. it ALWAYS increments).
// Returns (allowed bool, remaining int, resetAt time.Time).
func (r *RateLimiter) Allow(ctx context.Context, keyType, identity string, limit int, window time.Duration) (bool, int, time.Time, error) {
	key := r.prefix + keyType + identity
	now := time.Now()
	nowMS := now.UnixMilli()
	windowMS := window.Milliseconds()
	windowStart := nowMS - windowMS

	// Lua script: atomic trim + count + add
	// Returns current count AFTER adding the new entry.
	const script = `
		local key    = KEYS[1]
		local now    = tonumber(ARGV[1])
		local wstart = tonumber(ARGV[2])
		local ttl    = tonumber(ARGV[3])
		redis.call('ZREMRANGEBYSCORE', key, '-inf', wstart)
		local count = redis.call('ZADD', key, now, now .. '-' .. math.random(0, 999999))
		local total = redis.call('ZCARD', key)
		redis.call('PEXPIRE', key, ttl)
		return total
	`

	result, err := r.rdb.Eval(ctx, script, []string{key},
		nowMS,
		windowStart,
		windowMS+1000, // expire slightly after window to clean up
	).Int64()
	if err != nil {
		return false, 0, time.Time{}, fmt.Errorf("ratelimit: %w", err)
	}

	count := int(result)
	remaining := limit - count
	if remaining < 0 {
		remaining = 0
	}
	resetAt := now.Add(window)

	return count <= limit, remaining, resetAt, nil
}

// Reset clears all attempts for a key (e.g. on successful login).
func (r *RateLimiter) Reset(ctx context.Context, keyType, identity string) error {
	key := r.prefix + keyType + identity
	return r.rdb.Del(ctx, key).Err()
}

// Count returns the current attempt count without modifying state.
func (r *RateLimiter) Count(ctx context.Context, keyType, identity string, window time.Duration) (int, error) {
	key := r.prefix + keyType + identity
	now := time.Now().UnixMilli()
	windowStart := now - window.Milliseconds()

	n, err := r.rdb.ZCount(ctx, key, fmt.Sprintf("%d", windowStart), "+inf").Result()
	if err != nil {
		return 0, fmt.Errorf("ratelimit count: %w", err)
	}
	return int(n), nil
}
