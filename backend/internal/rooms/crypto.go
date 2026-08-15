package rooms

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"strings"
)

var ErrEncryptionUnavailable = errors.New("rooms chat encryption key is not configured")

type cryptor struct{ key []byte }

func newCryptor(keyHex string) (*cryptor, error) {
	if len(keyHex) != 64 {
		return nil, ErrEncryptionUnavailable
	}
	key, err := hex.DecodeString(keyHex)
	if err != nil || len(key) != 32 {
		return nil, ErrEncryptionUnavailable
	}
	return &cryptor{key: key}, nil
}

func (c *cryptor) encrypt(plain string) (string, error) {
	block, err := aes.NewCipher(c.key)
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
	return "v1:" + base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(plain), nil)), nil
}

func (c *cryptor) decrypt(value string) (string, error) {
	if !strings.HasPrefix(value, "v1:") {
		return "", errors.New("rooms legacy plaintext message")
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, "v1:"))
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(data) < gcm.NonceSize() {
		return "", errors.New("rooms ciphertext too short")
	}
	plain, err := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}
