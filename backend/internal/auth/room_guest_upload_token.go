package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

const roomGuestUploadTokenTTL = time.Hour

type RoomGuestUploadToken struct {
	GuestSessionID string
	RoomID         string
	OwnerID        string
	FolderID       string
}

type roomGuestUploadContextKey struct{}

func RoomGuestUploadFromContext(ctx context.Context) (RoomGuestUploadToken, bool) {
	value, ok := ctx.Value(roomGuestUploadContextKey{}).(RoomGuestUploadToken)
	return value, ok
}

func withRoomGuestUpload(ctx context.Context, data uploadTokenData) context.Context {
	return context.WithValue(ctx, roomGuestUploadContextKey{}, RoomGuestUploadToken{
		GuestSessionID: data.GuestSessionID,
		RoomID:         data.RoomID,
		OwnerID:        data.UserID,
		FolderID:       data.FolderID,
	})
}

func (h *Handler) IssueRoomGuestUploadToken(ctx context.Context, ownerID, folderID, guestSessionID, roomID string) (string, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("guest upload token: generate: %w", err)
	}
	token := hex.EncodeToString(random)
	data := uploadTokenData{
		UserID: ownerID, FolderID: folderID, Purpose: "room_guest_tus_upload",
		GuestSessionID: guestSessionID, RoomID: roomID,
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		return "", fmt.Errorf("guest upload token: encode: %w", err)
	}
	if err := h.rdb.Set(ctx, uploadTokenKey+token, encoded, roomGuestUploadTokenTTL).Err(); err != nil {
		return "", fmt.Errorf("guest upload token: store: %w", err)
	}
	return token, nil
}
