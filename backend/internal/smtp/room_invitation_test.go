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

	for _, expected := range []string{"Kenneth", "inviteret", "Projekt", "Sharedrive"} {
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

func TestRoomInvitationHTMLContainsBrandedCallToAction(t *testing.T) {
	const (
		instanceURL = "https://sharedrive.example.test"
		inviteURL   = instanceURL + "/rooms/invite/secret-token"
	)
	html := roomInvitationHTML("Kenneth", "Projekt", "guest", inviteURL, instanceURL)
	for _, expected := range []string{
		"Du er inviteret", "Kenneth", "Projekt", "Åbn chatrum", inviteURL,
		instanceURL + "/logo_name.png", "personlige gæstelink", "Sharedrive",
	} {
		if !strings.Contains(html, expected) {
			t.Fatalf("HTML invitation does not contain %q", expected)
		}
	}
}

func TestRoomInvitationHTMLEscapesUserControlledContent(t *testing.T) {
	html := roomInvitationHTML(`<script>alert("inviter")</script>`, `<img src=x onerror=alert("room")>`, "member",
		"https://sharedrive.example.test/rooms/id?a=1&b=2", "https://sharedrive.example.test")
	for _, forbidden := range []string{"<script>", "<img src=x"} {
		if strings.Contains(html, forbidden) {
			t.Fatalf("HTML invitation contains unescaped value %q", forbidden)
		}
	}
	for _, expected := range []string{"&lt;script&gt;", "&lt;img", "a=1&amp;b=2", "Log ind med din Sharedrive-konto"} {
		if !strings.Contains(html, expected) {
			t.Fatalf("HTML invitation does not contain escaped value %q", expected)
		}
	}
}
