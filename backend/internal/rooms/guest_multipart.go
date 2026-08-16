package rooms

import (
	"context"
	"mime/multipart"
	"net/http"

	"github.com/google/uuid"

	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/files"
	"github.com/yourname/privatedrive/internal/httputil"
)

type guestMultipartUpload struct {
	data     multipart.File
	name     string
	mimeType string
	size     int64
}

func readGuestMultipartUpload(w http.ResponseWriter, request *http.Request, maxFileBytes int64) (guestMultipartUpload, bool) {
	request.Body = http.MaxBytesReader(w, request.Body, maxFileBytes+(1<<20))
	if err := request.ParseMultipartForm(32 << 20); err != nil {
		httputil.RespondError(w, http.StatusRequestEntityTooLarge, "guest file exceeds the configured limit")
		return guestMultipartUpload{}, false
	}
	data, header, err := request.FormFile("file")
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "file is required")
		return guestMultipartUpload{}, false
	}
	if header.Size < 0 || header.Size > maxFileBytes {
		data.Close()
		httputil.RespondError(w, http.StatusRequestEntityTooLarge, "guest file exceeds the configured limit")
		return guestMultipartUpload{}, false
	}
	name, err := safeGuestFilename(header.Filename)
	if err != nil {
		data.Close()
		httputil.RespondError(w, http.StatusBadRequest, "invalid file name")
		return guestMultipartUpload{}, false
	}
	mimeType := header.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return guestMultipartUpload{data: data, name: name, mimeType: mimeType, size: header.Size}, true
}

func (handler *Handler) storeGuestUploadResource(ctx context.Context, access roomGuestAccess, folderID uuid.UUID, upload guestMultipartUpload) (ResourceView, error) {
	uploaded, err := handler.service.fileSvc.Upload(ctx, files.UploadParams{
		OwnerID: access.OwnerID.String(), Name: upload.name, MimeType: upload.mimeType,
		FolderID: folderID.String(), ContentLength: upload.size,
	}, upload.data)
	if err != nil {
		return ResourceView{}, err
	}
	resource, err := handler.service.AddResource(ctx, access.OwnerID, access.RoomID, ResourceFile, uploaded.ID)
	if err != nil {
		return ResourceView{}, err
	}
	if _, err := handler.service.db.Exec(ctx, `INSERT INTO room_guest_uploads(room_id,guest_session_id,file_id)
		VALUES($1,$2,$3)`, access.RoomID, access.SessionID, uploaded.ID); err != nil {
		return ResourceView{}, err
	}
	handler.service.log(ctx, audit.EventRoomGuestUpload, access.OwnerID,
		Room{ID: access.RoomID, Name: access.RoomName}, nil,
		map[string]any{"guest_session_id": access.SessionID, "file_id": uploaded.ID})
	handler.publish(ctx, access.RoomID)
	return resource, nil
}
