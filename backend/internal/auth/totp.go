package auth

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/argon2"
)

const (
	totpIssuer    = "PrivateDrive"
	backupCodeLen = 8
	backupCount   = 10
)

// TOTPService manages TOTP enroll/verify/revoke for users.
type TOTPService struct {
	db         *pgxpool.Pool
	encryptKey []byte // 32-byte AES-256 key
}

func NewTOTPService(db *pgxpool.Pool, encryptKeyHex string) (*TOTPService, error) {
	key, err := hex.DecodeString(encryptKeyHex)
	if err != nil || len(key) != 32 {
		return nil, fmt.Errorf("totp: TOTP_ENCRYPT_KEY must be 64 hex chars (32 bytes)")
	}
	return &TOTPService{db: db, encryptKey: key}, nil
}

// BeginEnroll generates a new TOTP secret + QR provisioning URI for the user.
// The secret is NOT yet stored — call ConfirmEnroll after the user verifies a code.
func (s *TOTPService) BeginEnroll(userEmail string) (secret, provisioningURI string, err error) {
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      totpIssuer,
		AccountName: userEmail,
	})
	if err != nil {
		return "", "", fmt.Errorf("totp: generate key: %w", err)
	}
	return key.Secret(), key.URL(), nil
}

// ConfirmEnroll validates the code, then encrypts and stores the secret.
// Returns the plaintext backup codes (shown once to the user).
func (s *TOTPService) ConfirmEnroll(ctx context.Context, userID, userEmail, secret, code string) (backupCodes []string, err error) {
	if !totp.Validate(code, secret) {
		return nil, fmt.Errorf("totp: invalid code")
	}

	encrypted, err := s.encrypt(secret)
	if err != nil {
		return nil, err
	}

	// Generate backup codes
	backupCodes, hashed, err := generateBackupCodes()
	if err != nil {
		return nil, err
	}

	_, err = s.db.Exec(ctx,
		`INSERT INTO totp_secrets (user_id, secret_enc, backup_codes_hash)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (user_id) DO UPDATE
		   SET secret_enc = EXCLUDED.secret_enc,
		       backup_codes_hash = EXCLUDED.backup_codes_hash,
		       enabled_at = now()`,
		userID, encrypted, hashed,
	)
	if err != nil {
		return nil, fmt.Errorf("totp: store secret: %w", err)
	}
	return backupCodes, nil
}

// Validate checks a TOTP code (or backup code) for a user.
func (s *TOTPService) Validate(ctx context.Context, userID, code string) error {
	row := s.db.QueryRow(ctx,
		`SELECT secret_enc, backup_codes_hash FROM totp_secrets WHERE user_id = $1`,
		userID,
	)
	var encSecret string
	var backupHash []string
	if err := row.Scan(&encSecret, &backupHash); err != nil {
		return fmt.Errorf("totp: user has no TOTP configured")
	}

	secret, err := s.decrypt(encSecret)
	if err != nil {
		return err
	}

	if totp.Validate(code, secret) {
		return nil
	}

	// Try backup codes
	return s.validateBackupCode(ctx, userID, code, backupHash)
}

// Disable removes TOTP for a user.
func (s *TOTPService) Disable(ctx context.Context, userID string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM totp_secrets WHERE user_id = $1`, userID)
	return err
}

// HasTOTP returns whether a user has TOTP enabled.
func (s *TOTPService) HasTOTP(ctx context.Context, userID string) (bool, error) {
	var exists bool
	err := s.db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM totp_secrets WHERE user_id = $1)`, userID,
	).Scan(&exists)
	return exists, err
}

// ─── AES-256-GCM encryption ──────────────────────────────────────────────────

func (s *TOTPService) encrypt(plaintext string) (string, error) {
	block, err := aes.NewCipher(s.encryptKey)
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
	ct := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(ct), nil
}

func (s *TOTPService) decrypt(ciphertext string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", fmt.Errorf("totp: base64 decode: %w", err)
	}
	block, err := aes.NewCipher(s.encryptKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(data) < gcm.NonceSize() {
		return "", fmt.Errorf("totp: ciphertext too short")
	}
	nonce, ct := data[:gcm.NonceSize()], data[gcm.NonceSize():]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", fmt.Errorf("totp: decrypt: %w", err)
	}
	return string(pt), nil
}

// ─── Backup codes ────────────────────────────────────────────────────────────

func generateBackupCodes() (plain []string, hashed []string, err error) {
	plain = make([]string, backupCount)
	hashed = make([]string, backupCount)
	for i := 0; i < backupCount; i++ {
		b := make([]byte, backupCodeLen)
		if _, err = rand.Read(b); err != nil {
			return nil, nil, err
		}
		code := hex.EncodeToString(b)[:backupCodeLen]
		plain[i] = code
		hashed[i] = hashBackupCode(code)
	}
	return plain, hashed, nil
}

func hashBackupCode(code string) string {
	// Use Argon2id for backup codes so brute-force is expensive even if DB leaks
	hash := argon2.IDKey([]byte(code), []byte("privatedrive-backup"), 1, 64*1024, 4, 32)
	return hex.EncodeToString(hash)
}

func (s *TOTPService) validateBackupCode(ctx context.Context, userID, code string, storedHashes []string) error {
	h := hashBackupCode(code)
	for i, stored := range storedHashes {
		if stored == h {
			// Invalidate used code
			newHashes := make([]string, len(storedHashes))
			copy(newHashes, storedHashes)
			newHashes[i] = "USED-" + stored
			_, _ = s.db.Exec(ctx,
				`UPDATE totp_secrets SET backup_codes_hash = $1 WHERE user_id = $2`,
				newHashes, userID,
			)
			return nil
		}
	}
	return fmt.Errorf("totp: invalid code")
}

// ─── Device trust ────────────────────────────────────────────────────────────

const deviceTrustTTL = 30 * 24 * time.Hour // 30 days

type DeviceTrustService struct {
	db     *pgxpool.Pool
	secret []byte
}

func NewDeviceTrustService(db *pgxpool.Pool, secretHex string) (*DeviceTrustService, error) {
	secret, err := hex.DecodeString(secretHex)
	if err != nil {
		return nil, fmt.Errorf("device_trust: invalid secret")
	}
	return &DeviceTrustService{db: db, secret: secret}, nil
}

// Issue creates a trusted device token for a user (post successful 2FA).
func (d *DeviceTrustService) Issue(ctx context.Context, userID, ip, ua string) (string, error) {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	raw := hex.EncodeToString(b)
	hash := hashToken(raw) // reuse SHA-256

	_, err := d.db.Exec(ctx,
		`INSERT INTO device_trust_tokens (user_id, token_hash, ip_address, user_agent, expires_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		userID, hash, ip, ua, time.Now().Add(deviceTrustTTL),
	)
	if err != nil {
		return "", fmt.Errorf("device_trust: %w", err)
	}
	return raw, nil
}

// Validate returns the userID if the raw token is valid and not expired.
func (d *DeviceTrustService) Validate(ctx context.Context, rawToken string) (string, error) {
	hash := hashToken(rawToken)
	var userID string
	err := d.db.QueryRow(ctx,
		`SELECT user_id FROM device_trust_tokens
		 WHERE token_hash = $1 AND expires_at > now() AND revoked_at IS NULL`,
		hash,
	).Scan(&userID)
	if err != nil {
		return "", fmt.Errorf("device_trust: invalid or expired token")
	}
	return userID, nil
}

// Revoke removes a single trust token.
func (d *DeviceTrustService) Revoke(ctx context.Context, rawToken string) error {
	hash := hashToken(rawToken)
	_, err := d.db.Exec(ctx,
		`UPDATE device_trust_tokens SET revoked_at = now() WHERE token_hash = $1`, hash,
	)
	return err
}
