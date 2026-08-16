package rooms

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"

	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/httputil"
)

type guestUploadTokenIssuer interface {
	IssueRoomGuestUploadToken(ctx context.Context, ownerID, folderID, guestSessionID, roomID string) (string, error)
}

func (handler *Handler) IssueGuestUploadToken(w http.ResponseWriter, request *http.Request) {
	if !handler.validGuestOrigin(request) {
		httputil.RespondError(w, http.StatusForbidden, "request origin is not allowed")
		return
	}
	access, ok := handler.guestAccess(w, request)
	if !ok {
		return
	}
	limits, folderID, err := handler.prepareGuestUpload(request.Context(), access)
	if err != nil {
		handler.respondGuestUploadPreparationError(w, err)
		return
	}
	if handler.uploadTokens == nil {
		handler.respondError(w, errors.New("guest upload token service unavailable"))
		return
	}
	token, err := handler.uploadTokens.IssueRoomGuestUploadToken(request.Context(), access.OwnerID.String(),
		folderID.String(), access.SessionID.String(), access.RoomID.String())
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]any{
		"token": token, "folder_id": folderID, "max_file_bytes": limits.MaxFileBytes,
	})
}

func (handler *Handler) ValidateGuestTusUpload(ctx context.Context, guestSessionID, roomID, ownerID, folderID string, size int64) error {
	access, err := handler.guestAccessByID(ctx, guestSessionID, roomID)
	if err != nil || access.OwnerID.String() != ownerID {
		return ErrForbidden
	}
	limits, err := handler.guestUploadLimits(ctx)
	if err != nil || !limits.Enabled || !access.CanUpload || size < 0 || size > limits.MaxFileBytes {
		return ErrForbidden
	}
	if err := handler.checkGuestUploadCounts(ctx, access, limits); err != nil {
		return err
	}
	expectedFolder, err := handler.ensureGuestUploadFolder(ctx, access)
	if err != nil || expectedFolder.String() != folderID {
		return ErrForbidden
	}
	ownerLimit := handler.service.fileSvc.GetEffectiveMaxUpload(ctx, ownerID, "", folderID)
	if size > ownerLimit {
		return ErrForbidden
	}
	return nil
}

func (handler *Handler) CompleteGuestTusUpload(ctx context.Context, guestSessionID, roomID, fileID string) error {
	access, err := handler.guestAccessByID(ctx, guestSessionID, roomID)
	if err != nil {
		return err
	}
	parsedFileID, err := uuid.Parse(fileID)
	if err != nil {
		return err
	}
	if _, err := handler.service.AddResource(ctx, access.OwnerID, access.RoomID, ResourceFile, parsedFileID); err != nil {
		return err
	}
	if _, err := handler.service.db.Exec(ctx, `INSERT INTO room_guest_uploads(room_id,guest_session_id,file_id)
		VALUES($1,$2,$3)`, access.RoomID, access.SessionID, parsedFileID); err != nil {
		return err
	}
	handler.service.log(ctx, audit.EventRoomGuestUpload, access.OwnerID, Room{ID: access.RoomID, Name: access.RoomName}, nil,
		map[string]any{"guest_session_id": access.SessionID, "file_id": parsedFileID})
	handler.publish(ctx, access.RoomID)
	return nil
}

func (handler *Handler) prepareGuestUpload(ctx context.Context, access roomGuestAccess) (guestUploadLimits, uuid.UUID, error) {
	limits, err := handler.guestUploadLimits(ctx)
	if err != nil || !limits.Enabled || !access.CanUpload {
		return limits, uuid.Nil, ErrForbidden
	}
	if err := handler.checkGuestUploadCounts(ctx, access, limits); err != nil {
		return limits, uuid.Nil, err
	}
	folderID, err := handler.ensureGuestUploadFolder(ctx, access)
	return limits, folderID, err
}

func (handler *Handler) respondGuestUploadPreparationError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrForbidden) {
		httputil.RespondError(w, http.StatusForbidden, "guest uploads are not enabled")
		return
	}
	if err != nil && (err.Error() == "guest session upload limit reached" || err.Error() == "Room guest upload limit reached") {
		httputil.RespondError(w, http.StatusTooManyRequests, err.Error())
		return
	}
	handler.respondError(w, err)
}
