package rooms

import (
	"errors"
	"strings"
	"testing"
)

func TestParseRemoteGIFURL(t *testing.T) {
	t.Parallel()
	valid := []string{
		"https://media.giphy.com/media/abc/giphy.gif",
		"https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExeW1lNmtseTlscjZpNjFzNnY0NDVwNDd3eTZ6ajYyMWU3ZXRxYXdpMCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/LQ6hYsehFSPVC/giphy.gif",
		"https://media.tenor.com/example.gif",
		"https://tenor.com/example.gif",
	}
	for _, raw := range valid {
		if _, err := parseRemoteGIFURL(raw); err != nil {
			t.Errorf("parseRemoteGIFURL(%q) returned %v", raw, err)
		}
	}

	invalid := []string{
		"http://media.giphy.com/media/abc/giphy.gif",
		"https://example.com/image.gif",
		"https://media.giphy.com/image.png",
		"https://user@media.giphy.com/image.gif",
	}
	for _, raw := range invalid {
		if _, err := parseRemoteGIFURL(raw); !errors.Is(err, ErrInvalidRemoteGIFURL) {
			t.Errorf("parseRemoteGIFURL(%q) error = %v", raw, err)
		}
	}
}

func TestValidGIFBinary(t *testing.T) {
	t.Parallel()
	if !validGIFBinary(append([]byte("GIF89a"), []byte("payload")...)) {
		t.Fatal("expected GIF89a binary to be accepted")
	}
	if !validGIFBinary(append([]byte("GIF87a"), []byte("payload")...)) {
		t.Fatal("expected GIF87a binary to be accepted")
	}
	if validGIFBinary([]byte("not-a-gif")) {
		t.Fatal("expected invalid binary to be rejected")
	}
	if validGIFBinary([]byte(strings.Repeat("x", starterGIFMaxBytes+1))) {
		t.Fatal("expected oversized binary to be rejected")
	}
}

func TestRemoteGIFTitle(t *testing.T) {
	t.Parallel()
	parsed, err := parseRemoteGIFURL("https://media.giphy.com/media/example/LQ6hYsehFSPVC/giphy.gif")
	if err != nil {
		t.Fatal(err)
	}
	if got := remoteGIFTitle(parsed); got != "media.giphy.com" {
		t.Fatalf("remoteGIFTitle() = %q", got)
	}
}
