package backup

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"fmt"
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

// ZipPassword returns the password used for ZIP AES-256 encryption of .shdbak
// archives. The raw backup token is used directly so that the user can open
// their archive in 7-Zip, WinZip, or any AES-ZIP compatible tool by entering
// their backup token as the password.
func ZipPassword(rawToken string) (string, error) {
	return rawToken, nil
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
