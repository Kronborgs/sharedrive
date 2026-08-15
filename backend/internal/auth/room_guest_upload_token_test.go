package auth

import (
	"context"
	"testing"
)

func TestRoomGuestUploadContextRoundTrip(t *testing.T) {
	data := uploadTokenData{
		UserID: "owner", FolderID: "folder", Purpose: "room_guest_tus_upload",
		GuestSessionID: "guest", RoomID: "room",
	}
	value, ok := RoomGuestUploadFromContext(withRoomGuestUpload(context.Background(), data))
	if !ok {
		t.Fatal("Room guest upload context was not stored")
	}
	if value.OwnerID != "owner" || value.FolderID != "folder" || value.GuestSessionID != "guest" || value.RoomID != "room" {
		t.Fatalf("unexpected Room guest upload context: %#v", value)
	}
}

func TestRoomGuestUploadContextAbsent(t *testing.T) {
	if _, ok := RoomGuestUploadFromContext(context.Background()); ok {
		t.Fatal("empty context must not contain Room guest upload scope")
	}
}
