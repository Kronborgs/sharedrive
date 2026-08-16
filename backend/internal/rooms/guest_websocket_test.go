package rooms

import (
	"testing"

	"github.com/google/uuid"
)

func TestGuestAccessWasRevoked(t *testing.T) {
	sessionID := uuid.New()
	inviteID := uuid.New()
	access := roomGuestAccess{SessionID: sessionID, InviteID: inviteID}
	tests := []struct {
		name    string
		payload string
		want    bool
	}{
		{"matching session", `{"type":"guest_session_revoked","guest_session_id":"` + sessionID.String() + `"}`, true},
		{"matching invite", `{"type":"guest_session_revoked","invite_id":"` + inviteID.String() + `"}`, true},
		{"different session", `{"type":"guest_session_revoked","guest_session_id":"` + uuid.NewString() + `"}`, false},
		{"ordinary update", `{"type":"messages_changed"}`, false},
		{"invalid event", `{`, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := guestAccessWasRevoked(test.payload, access); got != test.want {
				t.Fatalf("guestAccessWasRevoked() = %v, want %v", got, test.want)
			}
		})
	}
}
