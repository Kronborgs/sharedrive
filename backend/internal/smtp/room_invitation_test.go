package smtp

import (
	"strings"
	"testing"
)

func TestRoomInvitationContentUsesSharedriveInstanceAndInviteLink(t *testing.T) {
	const (
		instanceURL = "https://sharedrive.example.test"
		inviteURL   = instanceURL + "/rooms/invite/secret-token"
	)

	subject, body := roomInvitationContent("Kenneth", "Projekt", "guest", inviteURL, instanceURL)

	for _, expected := range []string{"Velkommen", "Projekt", "Sharedrive"} {
		if !strings.Contains(subject, expected) {
			t.Fatalf("subject %q does not contain %q", subject, expected)
		}
	}
	for _, expected := range []string{"Hej og velkommen til Sharedrive", instanceURL, inviteURL, "personligt og tidsbegrænset", "Kenneth"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("body does not contain %q", expected)
		}
	}
}

func TestRoomInvitationContentExplainsMemberLogin(t *testing.T) {
	_, body := roomInvitationContent("Kenneth", "Projekt", "member", "https://sharedrive.example.test/rooms/id", "https://sharedrive.example.test")
	if !strings.Contains(body, "Log ind med din Sharedrive-konto") {
		t.Fatal("member invitation does not explain account login")
	}
}
