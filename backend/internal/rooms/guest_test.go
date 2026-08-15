package rooms

import (
	"strings"
	"testing"
)

func TestSecureRoomTokenUsesRandomOpaqueValueAndHash(t *testing.T) {
	token, hash, err := secureRoomToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(token) < 40 || len(hash) != 64 {
		t.Fatalf("unexpected token/hash lengths: %d/%d", len(token), len(hash))
	}
	if hash != hashRoomToken(token) || strings.Contains(hash, token) {
		t.Fatal("stored token hash does not match the raw invitation token")
	}
}

func TestSafeGuestFilename(t *testing.T) {
	tests := map[string]string{
		"photo.jpg":            "photo.jpg",
		"../secret.txt":        "secret.txt",
		`..\windows\note.txt`: "note.txt",
		"  rapport.pdf  ":      "rapport.pdf",
	}
	for input, want := range tests {
		got, err := safeGuestFilename(input)
		if err != nil || got != want {
			t.Errorf("safeGuestFilename(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
	for _, invalid := range []string{"", ".", ".."} {
		if _, err := safeGuestFilename(invalid); err == nil {
			t.Errorf("safeGuestFilename(%q) should fail", invalid)
		}
	}
}

func TestParsePositiveGuestUploadSetting(t *testing.T) {
	if got := parsePositiveInt("12", 10); got != 12 {
		t.Fatalf("parsePositiveInt = %d", got)
	}
	if got := parsePositiveInt("0", 10); got != 10 {
		t.Fatalf("parsePositiveInt fallback = %d", got)
	}
	if got := parsePositiveInt64("26214400", 1); got != 26214400 {
		t.Fatalf("parsePositiveInt64 = %d", got)
	}
}
