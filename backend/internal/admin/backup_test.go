package admin

import (
	"testing"
	"time"
)

func TestRevokeRestoredGuestAccess(t *testing.T) {
	t.Parallel()

	data := backupData{
		RoomInvites:       []map[string]any{{"id": "invite", "revoked_at": nil}},
		RoomGuestSessions: []map[string]any{{"id": "session", "revoked_at": nil}},
	}

	revokeRestoredGuestAccess(&data)

	for _, record := range append(data.RoomInvites, data.RoomGuestSessions...) {
		revokedAt, ok := record["revoked_at"].(time.Time)
		if !ok || revokedAt.IsZero() {
			t.Fatalf("restored guest access was not revoked: %#v", record)
		}
	}
}

func TestIsRoomsBackupStep(t *testing.T) {
	t.Parallel()

	if !isRoomsBackupStep("rooms") || !isRoomsBackupStep("room_messages") {
		t.Fatal("Rooms backup steps must be recognised")
	}
	if isRoomsBackupStep("users") || isRoomsBackupStep("system_settings") {
		t.Fatal("non-Rooms backup steps must not be recognised as Rooms")
	}
}
