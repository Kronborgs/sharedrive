package rooms

import "testing"

func TestCryptorRoundTrip(t *testing.T) {
	c, err := newCryptor("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, err := c.encrypt("secret room message")
	if err != nil {
		t.Fatal(err)
	}
	if ciphertext == "secret room message" {
		t.Fatal("message was not encrypted")
	}
	plaintext, err := c.decrypt(ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	if plaintext != "secret room message" {
		t.Fatalf("got %q", plaintext)
	}
}

func TestCryptorRejectsInvalidKey(t *testing.T) {
	if _, err := newCryptor("invalid"); err == nil {
		t.Fatal("expected invalid key error")
	}
}
