package auth

import (
	"github.com/redis/go-redis/v9"
	"github.com/yourname/privatedrive/internal/ratelimit"
)

// RateLimiter is a type alias for the shared ratelimit.Limiter.
// All existing call-sites in the auth package continue to work unchanged.
type RateLimiter = ratelimit.Limiter

// NewRateLimiter creates a rate limiter. Kept for backwards compatibility.
func NewRateLimiter(rdb *redis.Client) *RateLimiter {
	return ratelimit.New(rdb)
}

// Key types used in the auth package.
const (
	KeyIPLogin         = "ip_login:"
	KeyUserLogin       = "user_login:"
	KeyIPGlobal        = "ip_global:"
	KeyIPPasswordReset = "ip_pwreset:"
	KeyIPInviteAccept  = "ip_invite:"
	KeyIPTOTPVerify    = "ip_totp_verify:"
)
