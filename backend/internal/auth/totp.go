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
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
	"github.com/rs/zerolog/log"
	"golang.org/x/crypto/argon2"
)

const (
	totpIssuer    = "Sharedrive"
	backupCodeLen = 8
	backupCount   = 10
)

// timeNow is a thin wrapper so tests can override the clock.
var timeNow = time.Now

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
	now := timeNow()
	valid, valErr := totp.ValidateCustom(code, secret, now, totp.ValidateOpts{
		Skew:      20, // ±10 minutes tolerance for clock drift
		Digits:    otp.DigitsSix,
		Period:    30,
		Algorithm: otp.AlgorithmSHA1,
	})
	log.Debug().
		Str("user_id", userID).
		Int("secret_len", len(secret)).
		Str("code", code).
		Int64("server_period", now.Unix()/30).
		Bool("valid", valid).
		Err(valErr).
		Msg("totp: confirm enroll validation")
	if valErr != nil || !valid {
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
		`INSERT INTO totp_credentials (user_id, encrypted_secret, backup_codes)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (user_id) DO UPDATE
		   SET encrypted_secret = EXCLUDED.encrypted_secret,
		       backup_codes     = EXCLUDED.backup_codes,
		       confirmed_at     = now()`,
		userID, encrypted, hashed,
	)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("totp: failed to store secret in DB")
		return nil, fmt.Errorf("totp: store secret: %w", err)
	}
	return backupCodes, nil
}

// Validate checks a TOTP code (or backup code) for a user.
func (s *TOTPService) Validate(ctx context.Context, userID, code string) error {
	row := s.db.QueryRow(ctx,
		`SELECT encrypted_secret, backup_codes FROM totp_credentials WHERE user_id = $1`,
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

	valid, _ := totp.ValidateCustom(code, secret, timeNow(), totp.ValidateOpts{Skew: 1, Digits: 6, Period: 30, Algorithm: otp.AlgorithmSHA1})
	if valid {
		return nil
	}

	// Try backup codes
	return s.validateBackupCode(ctx, userID, code, backupHash)
}

// Disable removes TOTP for a user.
func (s *TOTPService) Disable(ctx context.Context, userID string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM totp_credentials WHERE user_id = $1`, userID)
	return err
}

// HasTOTP returns whether a user has TOTP enabled.
func (s *TOTPService) HasTOTP(ctx context.Context, userID string) (bool, error) {
	var exists bool
	err := s.db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM totp_credentials WHERE user_id = $1)`, userID,
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
				`UPDATE totp_credentials SET backup_codes = $1 WHERE user_id = $2`,
				newHashes, userID,
			)
			return nil
		}
	}
	return fmt.Errorf("totp: invalid code")
}

