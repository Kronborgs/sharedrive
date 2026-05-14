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

	// Auto-push schedule fields.
	AutoPushEnabled       bool       `json:"auto_push_enabled"`
	AutoPushIntervalHours int        `json:"auto_push_interval_hours"`
	AutoPushOnChange      bool       `json:"auto_push_on_change"`
	AutoPushLastRunAt     *time.Time `json:"auto_push_last_run_at,omitempty"`
	AutoPushFolderIDs     []string   `json:"auto_push_folder_ids"`

	// Push failure / notification fields.
	PushFailedSince *time.Time `json:"push_failed_since,omitempty"`
	NotifyOnFailure bool       `json:"notify_on_failure"`

	// Fair-trade quota fields.
	ReceiveQuotaBytes *int64 `json:"receive_quota_bytes"` // null = unlimited
	PeerStoredBytes   int64  `json:"peer_stored_bytes"`   // bytes this user has stored at peer
}

// GetStatus returns the current buddy config summary for the user (no secrets exposed).
func (s *BuddyConfigService) GetStatus(ctx context.Context, userID uuid.UUID) (*BuddyUserStatus, error) {
	var peerURL, receiveTokenHash, receiveTokenPrefix, lastPushError string
	var lastPushAt *time.Time
	var lastPushBytes int64
	var pushInProgress bool
	var autoPushEnabled, autoPushOnChange bool
	var autoPushIntervalHours int
	var autoPushLastRunAt *time.Time
	var autoPushFolderIDs []string
	var pushFailedSince *time.Time
	var notifyOnFailure bool
	var receiveQuotaBytes *int64
	var peerStoredBytes int64
	err := s.db.QueryRow(ctx,
		`SELECT peer_url, receive_token_hash, receive_token_prefix,
		        last_push_at, last_push_bytes, push_in_progress, last_push_error,
		        auto_push_enabled, auto_push_interval_hours, auto_push_on_change,
		        auto_push_last_run_at, COALESCE(auto_push_folder_ids, '{}'),
		        push_failed_since, COALESCE(notify_on_failure, TRUE),
		        receive_quota_bytes, COALESCE(peer_stored_bytes, 0)
		 FROM user_buddy_configs WHERE user_id = $1`, userID,
	).Scan(&peerURL, &receiveTokenHash, &receiveTokenPrefix,
		&lastPushAt, &lastPushBytes, &pushInProgress, &lastPushError,
		&autoPushEnabled, &autoPushIntervalHours, &autoPushOnChange,
		&autoPushLastRunAt, &autoPushFolderIDs,
		&pushFailedSince, &notifyOnFailure,
		&receiveQuotaBytes, &peerStoredBytes)
	if err != nil {
		// No row yet — return empty status (not an error)
		return &BuddyUserStatus{
			UserID:                userID.String(),
			AutoPushIntervalHours: 24,
			AutoPushFolderIDs:     []string{},
			NotifyOnFailure:       true,
		}, nil
	}
	if autoPushFolderIDs == nil {
		autoPushFolderIDs = []string{}
	}
	return &BuddyUserStatus{
		UserID:                userID.String(),
		PeerConfigured:        peerURL != "",
		PeerURL:               peerURL,
		HasReceiveToken:       receiveTokenHash != "",
		ReceiveTokenPrefix:    receiveTokenPrefix,
		LastPushAt:            lastPushAt,
		LastPushBytes:         lastPushBytes,
		PushInProgress:        pushInProgress,
		LastPushError:         lastPushError,
		AutoPushEnabled:       autoPushEnabled,
		AutoPushIntervalHours: autoPushIntervalHours,
		AutoPushOnChange:      autoPushOnChange,
		AutoPushLastRunAt:     autoPushLastRunAt,
		AutoPushFolderIDs:     autoPushFolderIDs,
		PushFailedSince:       pushFailedSince,
		NotifyOnFailure:       notifyOnFailure,
		ReceiveQuotaBytes:     receiveQuotaBytes,
		PeerStoredBytes:       peerStoredBytes,
	}, nil
}

// SetAutoPushConfig saves the auto-push schedule settings for a user.
func (s *BuddyConfigService) SetAutoPushConfig(ctx context.Context, userID uuid.UUID, enabled bool, intervalHours int, onchange bool, folderIDs []string) error {
	if intervalHours < 1 {
		intervalHours = 24
	}
	if folderIDs == nil {
		folderIDs = []string{}
	}
	_, err := s.db.Exec(ctx,
		`INSERT INTO user_buddy_configs (user_id, auto_push_enabled, auto_push_interval_hours, auto_push_on_change, auto_push_folder_ids)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (user_id) DO UPDATE
		   SET auto_push_enabled        = EXCLUDED.auto_push_enabled,
		       auto_push_interval_hours = EXCLUDED.auto_push_interval_hours,
		       auto_push_on_change      = EXCLUDED.auto_push_on_change,
		       auto_push_folder_ids     = EXCLUDED.auto_push_folder_ids,
		       updated_at               = NOW()`,
		userID, enabled, intervalHours, onchange, folderIDs,
	)
	return err
}

// GetAutoPushUsers returns all user IDs that have auto-push enabled.
// Used by the scheduler.
func (s *BuddyConfigService) GetAutoPushUsers(ctx context.Context) ([]uuid.UUID, error) {
	rows, err := s.db.Query(ctx,
		`SELECT user_id FROM user_buddy_configs
		 WHERE auto_push_enabled = TRUE AND peer_url != ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			continue
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// GetAutoPushConfig returns just the auto-push scheduling fields for a user.
// Used internally by the scheduler.
type autoPushConfig struct {
	IntervalHours int
	OnChange      bool
	LastRunAt     *time.Time
	LastHash      string
	FolderIDs     []string
}

func (s *BuddyConfigService) getAutoPushConfig(ctx context.Context, userID uuid.UUID) (*autoPushConfig, error) {
	var cfg autoPushConfig
	err := s.db.QueryRow(ctx,
		`SELECT auto_push_interval_hours, auto_push_on_change,
		        auto_push_last_run_at, auto_push_last_hash,
		        COALESCE(auto_push_folder_ids, '{}')
		 FROM user_buddy_configs WHERE user_id = $1`, userID,
	).Scan(&cfg.IntervalHours, &cfg.OnChange, &cfg.LastRunAt, &cfg.LastHash, &cfg.FolderIDs)
	if err != nil {
		return nil, err
	}
	if cfg.FolderIDs == nil {
		cfg.FolderIDs = []string{}
	}
	return &cfg, nil
}

// updateAutoPushRun saves the hash and timestamp after a successful auto-push.
func (s *BuddyConfigService) updateAutoPushRun(ctx context.Context, userID uuid.UUID, hash string) error {
	_, err := s.db.Exec(ctx,
		`UPDATE user_buddy_configs
		 SET auto_push_last_run_at = NOW(), auto_push_last_hash = $2, updated_at = NOW()
		 WHERE user_id = $1`, userID, hash,
	)
	return err
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
// If peerTotalBytes > 0 (returned by an up-to-date peer), also updates peer_stored_bytes.
func (s *BuddyConfigService) UpdateLastPush(ctx context.Context, userID uuid.UUID, archiveBytes, peerTotalBytes int64) error {
	if peerTotalBytes > 0 {
		_, err := s.db.Exec(ctx,
			`UPDATE user_buddy_configs
			 SET last_push_at = NOW(), last_push_bytes = $2,
			     push_in_progress = FALSE, last_push_error = '',
			     peer_stored_bytes = $3, updated_at = NOW()
			 WHERE user_id = $1`, userID, archiveBytes, peerTotalBytes,
		)
		return err
	}
	// peerTotalBytes unknown (old peer without quota support) — preserve existing peer_stored_bytes.
	_, err := s.db.Exec(ctx,
		`UPDATE user_buddy_configs
		 SET last_push_at = NOW(), last_push_bytes = $2,
		     push_in_progress = FALSE, last_push_error = '', updated_at = NOW()
		 WHERE user_id = $1`, userID, archiveBytes,
	)
	return err
}

// SetReceiveQuota sets (or clears) the max bytes this user allows their buddy to store here.
// Pass nil to remove the cap (unlimited).
func (s *BuddyConfigService) SetReceiveQuota(ctx context.Context, userID uuid.UUID, quotaBytes *int64) error {
	_, err := s.db.Exec(ctx,
		`INSERT INTO user_buddy_configs (user_id, receive_quota_bytes)
		 VALUES ($1, $2)
		 ON CONFLICT (user_id) DO UPDATE
		   SET receive_quota_bytes = EXCLUDED.receive_quota_bytes,
		       updated_at          = NOW()`,
		userID, quotaBytes,
	)
	return err
}

// GetReceiveQuota returns the effective quota (bytes) for a buddy push from senderUserID
// to receiverUserID's server. The effective quota is max(configured, peer_stored_bytes)
// to enforce fair-trade: we never give less space than we're using at the sender's server.
// Returns unlimited=true when no cap is configured.
func (s *BuddyConfigService) GetReceiveQuota(ctx context.Context, receiverUserID, senderUserID uuid.UUID) (effectiveQuota int64, unlimited bool, err error) {
	var quota *int64
	var peerStored int64
	err = s.db.QueryRow(ctx,
		`SELECT receive_quota_bytes, COALESCE(peer_stored_bytes, 0)
		 FROM user_buddy_configs
		 WHERE user_id = $1 AND peer_user_id = $2`,
		receiverUserID, senderUserID,
	).Scan(&quota, &peerStored)
	if err != nil {
		// No matching outbound config — treat as unlimited.
		return 0, true, nil
	}
	if quota == nil {
		return 0, true, nil
	}
	// Fair trade: effective = max(configured quota, bytes we're using at sender's server).
	effective := *quota
	if peerStored > effective {
		effective = peerStored
	}
	return effective, false, nil
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

// RecordPushFailure records that a push attempt just failed.
// Sets push_failed_since to NOW() only if it is not already set (first failure).
func (s *BuddyConfigService) RecordPushFailure(ctx context.Context, userID uuid.UUID, pushErr string) error {
	_, err := s.db.Exec(ctx,
		`UPDATE user_buddy_configs
		 SET push_in_progress = FALSE,
		     last_push_error  = $2,
		     push_failed_since = COALESCE(push_failed_since, NOW()),
		     updated_at       = NOW()
		 WHERE user_id = $1`, userID, pushErr,
	)
	return err
}

// ClearPushFailure marks a push as successful: clears failure timestamp and error.
func (s *BuddyConfigService) ClearPushFailure(ctx context.Context, userID uuid.UUID) error {
	_, err := s.db.Exec(ctx,
		`UPDATE user_buddy_configs
		 SET push_failed_since = NULL,
		     last_push_error   = '',
		     updated_at        = NOW()
		 WHERE user_id = $1`, userID,
	)
	return err
}

// BackupFailureNotifyCandidate is a user whose automatic backup (buddy push or
// tertiary server backup) has been failing >24h and who has not been notified
// in the last 24h.
type BackupFailureNotifyCandidate struct {
	UserID      uuid.UUID
	Email       string
	Name        string
	BackupType  string // "Buddy backup" or "Server backup"
	Detail      string // peer URL for buddy, empty for tertiary
	FailedSince time.Time
}

// GetFailureNotifyCandidates returns candidates from BOTH buddy push and tertiary
// auto-backup that have been failing >24h and whose user has notify_on_failure=TRUE.
func (s *BuddyConfigService) GetFailureNotifyCandidates(ctx context.Context) ([]BackupFailureNotifyCandidate, error) {
	rows, err := s.db.Query(ctx,
		`-- Buddy push failures
		 SELECT ubc.user_id, u.email, u.name, 'Buddy backup', ubc.peer_url, ubc.push_failed_since
		 FROM user_buddy_configs ubc
		 JOIN users u ON u.id = ubc.user_id
		 WHERE ubc.push_failed_since IS NOT NULL
		   AND ubc.push_failed_since < NOW() - INTERVAL '24 hours'
		   AND COALESCE(ubc.notify_on_failure, TRUE) = TRUE
		   AND (ubc.last_failure_notified_at IS NULL
		        OR ubc.last_failure_notified_at < NOW() - INTERVAL '24 hours')
		 UNION ALL
		 -- Tertiary auto-backup failures
		 SELECT ubac.user_id, u.email, u.name, 'Server backup', '', ubac.auto_failed_since
		 FROM user_backup_auto_config ubac
		 JOIN users u ON u.id = ubac.user_id
		 WHERE ubac.auto_failed_since IS NOT NULL
		   AND ubac.auto_failed_since < NOW() - INTERVAL '24 hours'
		   AND COALESCE(ubac.notify_on_failure, TRUE) = TRUE
		   AND (ubac.last_failure_notified_at IS NULL
		        OR ubac.last_failure_notified_at < NOW() - INTERVAL '24 hours')`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BackupFailureNotifyCandidate
	for rows.Next() {
		var c BackupFailureNotifyCandidate
		if err := rows.Scan(&c.UserID, &c.Email, &c.Name, &c.BackupType, &c.Detail, &c.FailedSince); err != nil {
			continue
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// MarkBuddyFailureNotified records that a buddy failure notification was just sent.
func (s *BuddyConfigService) MarkBuddyFailureNotified(ctx context.Context, userID uuid.UUID) error {
	_, err := s.db.Exec(ctx,
		`UPDATE user_buddy_configs
		 SET last_failure_notified_at = NOW(), updated_at = NOW()
		 WHERE user_id = $1`, userID,
	)
	return err
}

// MarkTertiaryFailureNotified records that a tertiary failure notification was just sent.
func (s *BuddyConfigService) MarkTertiaryFailureNotified(ctx context.Context, userID uuid.UUID) error {
	_, err := s.db.Exec(ctx,
		`UPDATE user_backup_auto_config
		 SET last_failure_notified_at = NOW(), updated_at = NOW()
		 WHERE user_id = $1`, userID,
	)
	return err
}

// SetNotifyOnFailure updates the notification-on-failure preference for a user
// across BOTH backup types (buddy + tertiary). Uses upsert so it works even if
// the user has no rows yet in either table.
func (s *BuddyConfigService) SetNotifyOnFailure(ctx context.Context, userID uuid.UUID, enabled bool) error {
	_, err := s.db.Exec(ctx,
		`INSERT INTO user_buddy_configs (user_id, notify_on_failure)
		 VALUES ($1, $2)
		 ON CONFLICT (user_id) DO UPDATE
		   SET notify_on_failure = EXCLUDED.notify_on_failure,
		       updated_at        = NOW()`,
		userID, enabled,
	)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx,
		`INSERT INTO user_backup_auto_config (user_id, notify_on_failure)
		 VALUES ($1, $2)
		 ON CONFLICT (user_id) DO UPDATE
		   SET notify_on_failure = EXCLUDED.notify_on_failure,
		       updated_at        = NOW()`,
		userID, enabled,
	)
	return err
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
