package backup

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

// BuddyConfigService manages per-user buddy backup configuration stored in the DB.
// Each user has at most one row in user_buddy_configs.
//
// Receive side: the user generates a receive token (shown once, bcrypt-hashed in DB).
//
//	They share their base URL + user ID + receive token with their buddy.
//
// Push side: the user enters the peer's base URL, peer's user ID, and peer's receive
//
//	token. These are stored encrypted with the server wrap key.
type BuddyConfigService struct {
	db      *pgxpool.Pool
	wrapKey string // 64 hex chars = 32-byte AES-256 key
}

// NewBuddyConfigService creates a BuddyConfigService.
func NewBuddyConfigService(db *pgxpool.Pool, wrapKey string) *BuddyConfigService {
	return &BuddyConfigService{db: db, wrapKey: wrapKey}
}

// BuddyUserStatus is the non-secret summary returned to the frontend.
type BuddyUserStatus struct {
	UserID             string     `json:"user_id"`
	PeerConfigured     bool       `json:"peer_configured"`
	PeerURL            string     `json:"peer_url"` // full URL — safe to show
	HasReceiveToken    bool       `json:"has_receive_token"`
	ReceiveTokenPrefix string     `json:"receive_token_prefix"` // first 8 chars for UI hint
	LastPushAt         *time.Time `json:"last_push_at,omitempty"`
	LastPushBytes      int64      `json:"last_push_bytes"`
	PushInProgress     bool       `json:"push_in_progress"`
	LastPushError      string     `json:"last_push_error,omitempty"`
}

// GetStatus returns the current buddy config summary for the user (no secrets exposed).
func (s *BuddyConfigService) GetStatus(ctx context.Context, userID uuid.UUID) (*BuddyUserStatus, error) {
	var peerURL, receiveTokenHash, receiveTokenPrefix, lastPushError string
	var lastPushAt *time.Time
	var lastPushBytes int64
	var pushInProgress bool
	err := s.db.QueryRow(ctx,
		`SELECT peer_url, receive_token_hash, receive_token_prefix,
		        last_push_at, last_push_bytes, push_in_progress, last_push_error
		 FROM user_buddy_configs WHERE user_id = $1`, userID,
	).Scan(&peerURL, &receiveTokenHash, &receiveTokenPrefix,
		&lastPushAt, &lastPushBytes, &pushInProgress, &lastPushError)
	if err != nil {
		// No row yet — return empty status (not an error)
		return &BuddyUserStatus{UserID: userID.String()}, nil
	}
	return &BuddyUserStatus{
		UserID:             userID.String(),
		PeerConfigured:     peerURL != "",
		PeerURL:            peerURL,
		HasReceiveToken:    receiveTokenHash != "",
		ReceiveTokenPrefix: receiveTokenPrefix,
		LastPushAt:         lastPushAt,
		LastPushBytes:      lastPushBytes,
		PushInProgress:     pushInProgress,
		LastPushError:      lastPushError,
	}, nil
}

// SetPushInProgress marks the push as started or finished (with optional error).
func (s *BuddyConfigService) SetPushInProgress(ctx context.Context, userID uuid.UUID, inProgress bool, pushErr string) error {
	_, err := s.db.Exec(ctx,
		`UPDATE user_buddy_configs
		 SET push_in_progress = $2, last_push_error = $3, updated_at = NOW()
		 WHERE user_id = $1`, userID, inProgress, pushErr,
	)
	return err
}

// UpdateLastPush records the time and size of the most recent successful push.
func (s *BuddyConfigService) UpdateLastPush(ctx context.Context, userID uuid.UUID, sizeBytes int64) error {
	_, err := s.db.Exec(ctx,
		`UPDATE user_buddy_configs
		 SET last_push_at = NOW(), last_push_bytes = $2,
		     push_in_progress = FALSE, last_push_error = '', updated_at = NOW()
		 WHERE user_id = $1`, userID, sizeBytes,
	)
	return err
}

// validatePeerURL verifies that peerURL is a valid HTTPS URL with a hostname.
// Returns the normalised URL (no trailing slash) or an error.
func validatePeerURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimRight(raw, "/")
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("invalid peer URL: %w", err)
	}
	if u.Scheme != "https" {
		return "", fmt.Errorf("peer URL must use HTTPS (got %q)", u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return "", fmt.Errorf("peer URL has no hostname")
	}
	// Block localhost/loopback to prevent SSRF
	lower := strings.ToLower(host)
	if lower == "localhost" || lower == "127.0.0.1" || lower == "::1" || lower == "[::1]" {
		return "", fmt.Errorf("peer URL must not point to localhost")
	}
	// Block literal private/reserved IP addresses to prevent SSRF.
	// We do NOT resolve hostnames — a domain like sharedrive.example.com is
	// intentionally configured by the user and should be allowed even if it
	// resolves to a LAN address (Cloudflare Tunnel, split-horizon DNS, etc.).
	if ip := net.ParseIP(host); ip != nil {
		privateRanges := []string{
			"10.0.0.0/8",
			"172.16.0.0/12",
			"192.168.0.0/16",
			"127.0.0.0/8",
			"169.254.0.0/16",
			"::1/128",
			"fc00::/7",
			"fe80::/10",
		}
		for _, cidr := range privateRanges {
			_, ipNet, _ := net.ParseCIDR(cidr)
			if ipNet.Contains(ip) {
				return "", fmt.Errorf("peer URL must not use a private/reserved IP address")
			}
		}
	}
	return u.String(), nil
}

// SetPeerConfig stores (encrypted) the peer URL, peer user ID, and peer receive token.
// The peer URL must use HTTPS.
func (s *BuddyConfigService) SetPeerConfig(ctx context.Context, userID uuid.UUID, peerURL, peerUserID, peerToken string) error {
	normalised, err := validatePeerURL(peerURL)
	if err != nil {
		return err
	}
	enc, err := encryptBuddyValue(s.wrapKey, peerToken)
	if err != nil {
		return fmt.Errorf("encrypt peer token: %w", err)
	}
	_, err = s.db.Exec(ctx,
		`INSERT INTO user_buddy_configs (user_id, peer_url, peer_user_id, peer_token_enc)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (user_id) DO UPDATE
		   SET peer_url       = EXCLUDED.peer_url,
		       peer_user_id   = EXCLUDED.peer_user_id,
		       peer_token_enc = EXCLUDED.peer_token_enc,
		       updated_at     = NOW()`,
		userID, normalised, peerUserID, enc,
	)
	return err
}

// ClearPeerConfig removes the stored peer URL and token for a user.
func (s *BuddyConfigService) ClearPeerConfig(ctx context.Context, userID uuid.UUID) error {
	_, err := s.db.Exec(ctx,
		`UPDATE user_buddy_configs
		 SET peer_url = '', peer_user_id = '', peer_token_enc = '', updated_at = NOW()
		 WHERE user_id = $1`, userID,
	)
	return err
}

// GenerateReceiveToken creates a new cryptographically-random receive token for the user.
// Returns the raw token (must be shown to the user immediately; not stored in plaintext).
func (s *BuddyConfigService) GenerateReceiveToken(ctx context.Context, userID uuid.UUID) (string, error) {
	raw := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	token := base64.URLEncoding.EncodeToString(raw) // 44 URL-safe chars

	hash, err := bcrypt.GenerateFromPassword([]byte(token), bcrypt.DefaultCost)
	if err != nil {
		return "", fmt.Errorf("hash token: %w", err)
	}

	_, err = s.db.Exec(ctx,
		`INSERT INTO user_buddy_configs (user_id, receive_token_hash, receive_token_prefix)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (user_id) DO UPDATE
		   SET receive_token_hash   = EXCLUDED.receive_token_hash,
		       receive_token_prefix = EXCLUDED.receive_token_prefix,
		       updated_at           = NOW()`,
		userID, string(hash), token[:8],
	)
	if err != nil {
		return "", err
	}
	return token, nil
}

// RevokeReceiveToken clears the receive token for a user.
func (s *BuddyConfigService) RevokeReceiveToken(ctx context.Context, userID uuid.UUID) error {
	_, err := s.db.Exec(ctx,
		`UPDATE user_buddy_configs
		 SET receive_token_hash = '', receive_token_prefix = '', updated_at = NOW()
		 WHERE user_id = $1`, userID,
	)
	return err
}

// GetPeerConfig decrypts and returns the peer URL, peer user ID, and peer token for use in Push.
func (s *BuddyConfigService) GetPeerConfig(ctx context.Context, userID uuid.UUID) (peerURL, peerUserID, peerToken string, err error) {
	var encToken string
	err = s.db.QueryRow(ctx,
		`SELECT peer_url, peer_user_id, peer_token_enc FROM user_buddy_configs WHERE user_id = $1`, userID,
	).Scan(&peerURL, &peerUserID, &encToken)
	if err != nil {
		return "", "", "", fmt.Errorf("buddy peer config not found")
	}
	if peerURL == "" {
		return "", "", "", fmt.Errorf("peer not configured")
	}
	peerToken, err = decryptBuddyValue(s.wrapKey, encToken)
	if err != nil {
		return "", "", "", fmt.Errorf("decrypt peer token: %w", err)
	}
	return peerURL, peerUserID, peerToken, nil
}

// ValidateReceiveToken checks a provided token against the stored bcrypt hash for the user.
func (s *BuddyConfigService) ValidateReceiveToken(ctx context.Context, userID uuid.UUID, token string) error {
	var hash string
	err := s.db.QueryRow(ctx,
		`SELECT receive_token_hash FROM user_buddy_configs WHERE user_id = $1`, userID,
	).Scan(&hash)
	if err != nil || hash == "" {
		return fmt.Errorf("receive token not configured for this user")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(token)); err != nil {
		return fmt.Errorf("invalid receive token")
	}
	return nil
}

// ── AES-256-GCM helpers ───────────────────────────────────────────────────────

func encryptBuddyValue(hexKey, plaintext string) (string, error) {
	key, err := hex.DecodeString(hexKey)
	if err != nil || len(key) != 32 {
		return "", fmt.Errorf("invalid wrap key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(plaintext), nil)), nil
}

func decryptBuddyValue(hexKey, enc string) (string, error) {
	key, err := hex.DecodeString(hexKey)
	if err != nil || len(key) != 32 {
		return "", fmt.Errorf("invalid wrap key")
	}
	data, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}
	plaintext, err := gcm.Open(nil, data[:nonceSize], data[nonceSize:], nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}
	return string(plaintext), nil
}
