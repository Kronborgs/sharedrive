package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
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
// It also performs risk-aware checks: if the user agent family or IP prefix
// has changed significantly since the token was issued, it is rejected.
func (s *DeviceTrustService) Validate(ctx context.Context, raw, currentIP, currentUA string) (string, error) {
	hash := s.tokenHash(raw)

	var userID, storedIP, storedUA string
	err := s.db.QueryRow(ctx,
		`SELECT user_id::TEXT, ip_address, user_agent
		 FROM device_trust_tokens
		 WHERE token_hash = $1
		   AND revoked_at IS NULL
		   AND expires_at > now()`,
		hash,
	).Scan(&userID, &storedIP, &storedUA)
	if err != nil {
		return "", fmt.Errorf("device trust: invalid or expired token")
	}

	// Risk check: compare user-agent family (browser + OS prefix).
	// We extract the first token (e.g. "Mozilla/5.0") and a rough OS/browser
	// substring. If they differ substantially, reject the token.
	if !uaFamilyMatch(storedUA, currentUA) {
		// Revoke the token — it's been used from a different browser/device.
		_, _ = s.db.Exec(ctx,
			`UPDATE device_trust_tokens SET revoked_at = now() WHERE token_hash = $1`, hash)
		return "", fmt.Errorf("device trust: user agent mismatch — token revoked")
	}

	// Risk check: coarse IP comparison (same /16 for IPv4, same /48 for IPv6).
	// This catches cross-country jumps while allowing normal ISP DHCP changes.
	if !coarseIPMatch(storedIP, currentIP) {
		_, _ = s.db.Exec(ctx,
			`UPDATE device_trust_tokens SET revoked_at = now() WHERE token_hash = $1`, hash)
		return "", fmt.Errorf("device trust: IP range mismatch — token revoked")
	}

	// Best-effort: update last_used_at and current IP/UA for audit purposes.
	_, _ = s.db.Exec(ctx,
		`UPDATE device_trust_tokens SET last_used_at = now(), ip_address = $2, user_agent = $3 WHERE token_hash = $1`,
		hash, currentIP, currentUA,
	)
	return userID, nil
}

// uaFamilyMatch does a coarse comparison of user agent strings.
// It extracts the browser engine token (e.g. "Chrome", "Firefox", "Safari")
// and considers them matching if they share the same engine.
func uaFamilyMatch(stored, current string) bool {
	// If the stored UA family is known but the current request sends no UA header,
	// treat it as a mismatch — a real browser always sends a User-Agent.
	// Only allow the check to pass when *both* are empty (non-browser client that
	// never sends UA, in which case we have nothing useful to compare).
	if stored == "" && current == "" {
		return true
	}
	if stored == "" || current == "" {
		return false
	}
	return extractUAFamily(stored) == extractUAFamily(current)
}

// extractUAFamily extracts a rough "browser family" from a user-agent string.
func extractUAFamily(ua string) string {
	ua = strings.ToLower(ua)
	// Order matters — check specific browsers before engines.
	families := []struct{ keyword, family string }{
		{"edg/", "edge"},
		{"opr/", "opera"},
		{"opera", "opera"},
		{"firefox/", "firefox"},
		{"chrome/", "chrome"},
		{"safari/", "safari"},
		{"msie", "ie"},
		{"trident/", "ie"},
	}
	for _, f := range families {
		if strings.Contains(ua, f.keyword) {
			return f.family
		}
	}
	return "unknown"
}

// coarseIPMatch checks if two IPs are in the same coarse range.
// IPv4: same /16. IPv6: same /48.
func coarseIPMatch(a, b string) bool {
	if a == "" || b == "" {
		return true // skip check if either is missing
	}
	// Simple approach: compare IP prefix strings.
	partsA := strings.Split(a, ".")
	partsB := strings.Split(b, ".")
	if len(partsA) == 4 && len(partsB) == 4 {
		// IPv4: compare first two octets (/16)
		return partsA[0] == partsB[0] && partsA[1] == partsB[1]
	}
	// IPv6: compare first 3 groups (/48 equivalent)
	v6a := strings.Split(a, ":")
	v6b := strings.Split(b, ":")
	if len(v6a) >= 3 && len(v6b) >= 3 {
		return v6a[0] == v6b[0] && v6a[1] == v6b[1] && v6a[2] == v6b[2]
	}
	// Mixed or unparseable — allow
	return true
}
