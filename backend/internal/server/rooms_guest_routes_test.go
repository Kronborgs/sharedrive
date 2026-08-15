package server

import (
	"net/http"
	"testing"
)

func TestRoomGuestUploadSkipsSmallJSONBodyLimit(t *testing.T) {
	if shouldApplyGlobalBodyLimit("/api/v1/guest/rooms/room-id/uploads", http.MethodPost) {
		t.Fatal("guest upload must use its own configured multipart body limit")
	}
	if !shouldApplyGlobalBodyLimit("/api/v1/guest/rooms/room-id/uploads", http.MethodGet) {
		t.Fatal("only POST guest uploads may skip the global body limit")
	}
}

func TestSensitiveTokenPathRedactsRoomInvitations(t *testing.T) {
	tests := map[string]string{
		"/rooms/invite/secret":                                  "/rooms/invite/[redacted]",
		"/api/v1/public/rooms/invitations/secret/accept":        "/api/v1/public/rooms/invitations/[redacted]/accept",
		"/api/v1/public/notes/invitations/note-secret/accept":   "/api/v1/public/notes/invitations/[redacted]/accept",
		"/api/v1/public/rooms/invitations-not-a-token/ordinary": "",
		"/api/v1/rooms": "",
	}
	for input, want := range tests {
		if got := sensitiveTokenPath(input); got != want {
			t.Errorf("sensitiveTokenPath(%q) = %q, want %q", input, got, want)
		}
	}
}
