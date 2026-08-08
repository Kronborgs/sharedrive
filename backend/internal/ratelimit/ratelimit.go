package ratelimit

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Key type constants for download rate limiting.
const (
	KeyUserDownload = "user_dl:"
	KeyIPDownload   = "ip_dl:"
	KeyUserZipDL    = "user_zip:"
	KeyIPZipDL      = "ip_zip:"
	KeyUserNoteInvite    = "user_note_invite:"
	KeyNoteShareResend   = "note_share_resend:"
	KeyIPNoteInviteAccept = "ip_note_invite_accept:"
	KeyGuestNoteMutation = "guest_note_mutation:"
)

// Limiter implements a sliding-window counter using a Redis sorted set.
// Each attempt is stored as a member with score = unix timestamp (ms).
// The window is trimmed on every check so memory stays bounded.
type Limiter struct {
	rdb    *redis.Client
	prefix string
}

// New creates a Limiter. All Redis keys are prefixed with "rl:".
func New(rdb *redis.Client) *Limiter {
	return &Limiter{rdb: rdb, prefix: "rl:"}
}

// Allow checks whether the key is within limit attempts per window.
// It also records the current attempt (i.e. it ALWAYS increments).
// Returns (allowed bool, remaining int, resetAt time.Time, error).
func (l *Limiter) Allow(ctx context.Context, keyType, identity string, limit int, window time.Duration) (bool, int, time.Time, error) {
	key := l.prefix + keyType + identity
	now := time.Now()
	nowMS := now.UnixMilli()
	windowMS := window.Milliseconds()
	windowStart := nowMS - windowMS

	// Lua script: atomic trim + add + count.
	// Returns current count AFTER adding the new entry.
	const script = `
		local key    = KEYS[1]
		local now    = tonumber(ARGV[1])
		local wstart = tonumber(ARGV[2])
		local ttl    = tonumber(ARGV[3])
		redis.call('ZREMRANGEBYSCORE', key, '-inf', wstart)
		redis.call('ZADD', key, now, now .. '-' .. math.random(0, 999999))
		local total = redis.call('ZCARD', key)
		redis.call('PEXPIRE', key, ttl)
		return total
	`

	result, err := l.rdb.Eval(ctx, script, []string{key},
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
	return count <= limit, remaining, now.Add(window), nil
}

// Reset clears all attempts for a key (e.g. on successful action).
func (l *Limiter) Reset(ctx context.Context, keyType, identity string) error {
	key := l.prefix + keyType + identity
	return l.rdb.Del(ctx, key).Err()
}

// Count returns the current attempt count without modifying state.
func (l *Limiter) Count(ctx context.Context, keyType, identity string, window time.Duration) (int, error) {
	key := l.prefix + keyType + identity
	now := time.Now().UnixMilli()
	windowStart := now - window.Milliseconds()

	n, err := l.rdb.ZCount(ctx, key, fmt.Sprintf("%d", windowStart), "+inf").Result()
	if err != nil {
		return 0, fmt.Errorf("ratelimit count: %w", err)
	}
	return int(n), nil
}
