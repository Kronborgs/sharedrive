package rooms

import (
	"testing"

	"github.com/google/uuid"
)

func TestUserRoomsAccessWasRevoked(t *testing.T) {
	userID := uuid.New()
	if !userRoomsAccessWasRevoked(`{"type":"user_rooms_access_revoked","user_id":"`+userID.String()+`"}`, userID) {
		t.Fatal("matching Rooms access revoke event was not detected")
	}
	if userRoomsAccessWasRevoked(`{"type":"user_rooms_access_revoked","user_id":"`+uuid.NewString()+`"}`, userID) {
		t.Fatal("another user's revoke event was accepted")
	}
	if userRoomsAccessWasRevoked(`{"type":"messages_changed"}`, userID) {
		t.Fatal("ordinary message update was treated as an access revoke")
	}
}
