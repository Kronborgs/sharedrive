package backup

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"

	"golang.org/x/crypto/hkdf"
)

// generateRawToken returns 32 cryptographically-random bytes encoded as a
// lowercase hex string (64 characters).
func generateRawToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("backup: rand: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// DeriveZipKey derives a 32-byte ZIP encryption key from rawToken using
// HKDF-SHA256 with the domain separator "sharedrive-backup-v1".
// The same rawToken always produces the same zipKey, so the archive can be
// re-derived at restore time without storing the key.
func DeriveZipKey(rawToken string) ([]byte, error) {
	r := hkdf.New(sha256.New, []byte(rawToken), nil, []byte("sharedrive-backup-v1"))
	key := make([]byte, 32)
	if _, err := io.ReadFull(r, key); err != nil {
		return nil, fmt.Errorf("backup: hkdf: %w", err)
	}
	return key, nil
}

// ZipPassword returns the yeka/zip password string for archives created from
// rawToken (hex-encoded 32-byte derived key = 64 ASCII characters).
func ZipPassword(rawToken string) (string, error) {
	key, err := DeriveZipKey(rawToken)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(key), nil
}

// WrapKey encrypts zipKey with AES-256-GCM using wrapKeyHex (64-char hex = 32 bytes).
// Returns a nonce-prefixed ciphertext ready for storage. Returns nil, nil when
// wrapKeyHex is empty (wrap-key not configured).
func WrapKey(zipKey []byte, wrapKeyHex string) ([]byte, error) {
	if wrapKeyHex == "" {
		return nil, nil
	}
	wk, err := hex.DecodeString(wrapKeyHex)
	if err != nil {
		return nil, fmt.Errorf("backup: invalid wrap key hex: %w", err)
	}
	if len(wk) != 32 {
		return nil, fmt.Errorf("backup: wrap key must be 32 bytes, got %d", len(wk))
	}
	block, err := aes.NewCipher(wk)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return append(nonce, gcm.Seal(nil, nonce, zipKey, nil)...), nil
}

// UnwrapKey decrypts a wrapped ZIP key using wrapKeyHex. Returns an error if
// the key is tampered or wrapKeyHex is wrong.
func UnwrapKey(wrapped []byte, wrapKeyHex string) ([]byte, error) {
	wk, err := hex.DecodeString(wrapKeyHex)
	if err != nil {
		return nil, fmt.Errorf("backup: invalid wrap key hex: %w", err)
	}
	if len(wk) != 32 {
		return nil, fmt.Errorf("backup: wrap key must be 32 bytes")
	}
	block, err := aes.NewCipher(wk)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	ns := gcm.NonceSize()
	if len(wrapped) < ns {
		return nil, fmt.Errorf("backup: wrapped key too short")
	}
	return gcm.Open(nil, wrapped[:ns], wrapped[ns:], nil)
}
