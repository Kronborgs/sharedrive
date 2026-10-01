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
	"strings"
	"time"

	"github.com/google/uuid"
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

// MFAMethod describes an enrolled MFA method without exposing secrets.
type MFAMethod struct {
	ID           uuid.UUID  `json:"id"`
	MethodType   string     `json:"method_type"`
	Label        string     `json:"label"`
	EmailAddress *string    `json:"email_address,omitempty"`
	IsActive     bool       `json:"is_active"`
	LastUsedAt   *time.Time `json:"last_used_at,omitempty"`
	DisabledAt   *time.Time `json:"disabled_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}
// TOTPService manages TOTP enrollment, verification, and revocation.
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
func (s *TOTPService) ConfirmEnroll(ctx context.Context, userID, userEmail, secret, code, label string) (backupCodes []string, err error) {
	now := timeNow()
	valid, valErr := totp.ValidateCustom(code, secret, now, totp.ValidateOpts{
		Skew:      1, // ±30 seconds — one step before/after current
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

	if strings.TrimSpace(label) == "" {
		label = "Authenticator"
	}
	_, err = s.db.Exec(ctx,
		`INSERT INTO mfa_methods (user_id, method_type, label, encrypted_secret, backup_codes)
		 VALUES ($1, 'totp', $2, $3, $4)`,
		userID, label, encrypted, hashed,
	)
	if err != nil {
		log.Error().Err(err).Str("user_id", userID).Msg("totp: failed to store secret in DB")
		return nil, fmt.Errorf("totp: store secret: %w", err)
	}
	return backupCodes, nil
}

// Validate checks a TOTP code (or backup code) for any active TOTP method.
func (s *TOTPService) Validate(ctx context.Context, userID, code string) error {
	rows, err := s.db.Query(ctx,
		`SELECT id, encrypted_secret, backup_codes
		   FROM mfa_methods
		  WHERE user_id = $1 AND method_type = 'totp' AND is_active = true
		  ORDER BY last_used_at DESC NULLS LAST, created_at`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("totp: list methods: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var methodID uuid.UUID
		var encSecret string
		var backupHash []string
		if err := rows.Scan(&methodID, &encSecret, &backupHash); err != nil {
			return fmt.Errorf("totp: read method: %w", err)
		}
		secret, err := s.decrypt(encSecret)
		if err != nil {
			continue
		}
		valid, _ := totp.ValidateCustom(code, secret, timeNow(), totp.ValidateOpts{Skew: 1, Digits: otp.DigitsSix, Period: 30, Algorithm: otp.AlgorithmSHA1})
		if valid {
			_, _ = s.db.Exec(ctx, `UPDATE mfa_methods SET last_used_at = now() WHERE id = $1`, methodID)
			return nil
		}
		if s.validateBackupCode(ctx, methodID, code, backupHash) == nil {
			_, _ = s.db.Exec(ctx, `UPDATE mfa_methods SET last_used_at = now() WHERE id = $1`, methodID)
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("totp: iterate methods: %w", err)
	}
	return fmt.Errorf("totp: invalid code")
}

// Disable removes all MFA methods for a user. This is reserved for administrator actions.
func (s *TOTPService) Disable(ctx context.Context, userID string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM mfa_methods WHERE user_id = $1`, userID)
	return err
}

// HasTOTP returns whether a user has at least one active TOTP method.
func (s *TOTPService) HasTOTP(ctx context.Context, userID string) (bool, error) {
	var exists bool
	err := s.db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM mfa_methods WHERE user_id = $1 AND method_type = 'totp' AND is_active = true)`,
		userID,
	).Scan(&exists)
	return exists, err
}

// ListMethods returns all MFA methods for a user without exposing secrets.
func (s *TOTPService) ListMethods(ctx context.Context, userID string) ([]MFAMethod, error) {
	rows, err := s.db.Query(ctx,
		`SELECT id, method_type, label, email_address, is_active, last_used_at, disabled_at, created_at
		   FROM mfa_methods WHERE user_id = $1 ORDER BY created_at, id`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var methods []MFAMethod
	for rows.Next() {
		var method MFAMethod
		if err := rows.Scan(&method.ID, &method.MethodType, &method.Label, &method.EmailAddress, &method.IsActive, &method.LastUsedAt, &method.DisabledAt, &method.CreatedAt); err != nil {
			return nil, err
		}
		methods = append(methods, method)
	}
	return methods, rows.Err()
}

// DeleteMethod removes a user's MFA method but never their last active method.
func (s *TOTPService) DeleteMethod(ctx context.Context, userID, methodID string) error {
	tag, err := s.db.Exec(ctx,
		`DELETE FROM mfa_methods
		  WHERE id = $1 AND user_id = $2
		    AND (NOT is_active OR (SELECT count(*) FROM mfa_methods WHERE user_id = $2 AND is_active = true) > 1)`,
		methodID, userID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("mfa: cannot remove the last active method or method was not found")
	}
	return nil
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

func (s *TOTPService) validateBackupCode(ctx context.Context, methodID uuid.UUID, code string, storedHashes []string) error {
	h := hashBackupCode(code)
	for i, stored := range storedHashes {
		if stored == h {
			// Invalidate used code
			newHashes := make([]string, len(storedHashes))
			copy(newHashes, storedHashes)
			newHashes[i] = "USED-" + stored
			_, _ = s.db.Exec(ctx,
				`UPDATE mfa_methods SET backup_codes = $1 WHERE id = $2`,
				newHashes, methodID,
			)
			return nil
		}
	}
	return fmt.Errorf("totp: invalid code")
}
