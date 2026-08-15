package rooms

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/yourname/privatedrive/internal/files"
	"github.com/yourname/privatedrive/internal/httputil"
)

type guestUploadLimits struct {
	Enabled         bool
	MaxFileBytes    int64
	MaxFilesSession int
	MaxFilesRoomDay int
}

func (handler *Handler) GuestUpload(w http.ResponseWriter, request *http.Request) {
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
	upload, ok := readGuestMultipartUpload(w, request, limits.MaxFileBytes)
	if !ok {
		return
	}
	defer upload.data.Close()
	ownerLimit := handler.service.fileSvc.GetEffectiveMaxUpload(request.Context(), access.OwnerID.String(), "", folderID.String())
	if upload.size > ownerLimit {
		httputil.RespondError(w, http.StatusRequestEntityTooLarge, "file exceeds the Room owner's upload limit")
		return
	}
	resource, err := handler.storeGuestUploadResource(request.Context(), access, folderID, upload)
	if err != nil {
		handler.respondGuestUploadError(w, err)
		return
	}
	httputil.Respond(w, http.StatusCreated, resource)
}

func (handler *Handler) guestUploadLimits(ctx context.Context) (guestUploadLimits, error) {
	limits := guestUploadLimits{MaxFileBytes: 25 * 1024 * 1024, MaxFilesSession: 10, MaxFilesRoomDay: 100}
	rows, err := handler.service.db.Query(ctx, `SELECT key,value FROM system_settings WHERE key IN
		('rooms_guest_uploads_enabled','rooms_guest_upload_max_file_bytes','rooms_guest_upload_max_files_session','rooms_guest_upload_max_files_room_day')`)
	if err != nil {
		return limits, err
	}
	defer rows.Close()
	values := make(map[string]string, 4)
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return limits, err
		}
		values[key] = value
	}
	limits.Enabled = values["rooms_guest_uploads_enabled"] == "true"
	limits.MaxFileBytes = parsePositiveInt64(values["rooms_guest_upload_max_file_bytes"], limits.MaxFileBytes)
	limits.MaxFilesSession = parsePositiveInt(values["rooms_guest_upload_max_files_session"], limits.MaxFilesSession)
	limits.MaxFilesRoomDay = parsePositiveInt(values["rooms_guest_upload_max_files_room_day"], limits.MaxFilesRoomDay)
	return limits, rows.Err()
}

func (handler *Handler) checkGuestUploadCounts(ctx context.Context, access roomGuestAccess, limits guestUploadLimits) error {
	var sessionCount, roomDayCount int
	err := handler.service.db.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM room_guest_uploads WHERE guest_session_id=$1),
		(SELECT count(*) FROM room_guest_uploads WHERE room_id=$2 AND created_at>now()-interval '24 hours')`,
		access.SessionID, access.RoomID).Scan(&sessionCount, &roomDayCount)
	if err != nil {
		return err
	}
	if sessionCount >= limits.MaxFilesSession {
		return errors.New("guest session upload limit reached")
	}
	if roomDayCount >= limits.MaxFilesRoomDay {
		return errors.New("Room guest upload limit reached")
	}
	return nil
}

func (handler *Handler) ensureGuestUploadFolder(ctx context.Context, access roomGuestAccess) (uuid.UUID, error) {
	roomsFolder, err := handler.ensureOwnedFolder(ctx, access.OwnerID, "Rooms", nil)
	if err != nil {
		return uuid.Nil, err
	}
	roomFolder, err := handler.ensureOwnedFolder(ctx, access.OwnerID, access.RoomSlug, &roomsFolder)
	if err != nil {
		return uuid.Nil, err
	}
	return handler.ensureOwnedFolder(ctx, access.OwnerID, "Guest uploads", &roomFolder)
}

func (handler *Handler) ensureOwnedFolder(ctx context.Context, ownerID uuid.UUID, name string, parentID *uuid.UUID) (uuid.UUID, error) {
	tx, err := handler.service.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(ctx)
	lockKey := ownerID.String() + ":" + name
	if parentID != nil {
		lockKey += ":" + parentID.String()
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, lockKey); err != nil {
		return uuid.Nil, err
	}
	var id uuid.UUID
	var isFolder bool
	err = tx.QueryRow(ctx, `SELECT id,is_folder FROM files WHERE owner_id=$1 AND parent_id IS NOT DISTINCT FROM $2
		AND name=$3 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, ownerID, parentID, name).Scan(&id, &isFolder)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `INSERT INTO files(owner_id,parent_id,is_folder,name) VALUES($1,$2,TRUE,$3) RETURNING id`,
			ownerID, parentID, name).Scan(&id)
		isFolder = true
	}
	if err != nil || !isFolder {
		return uuid.Nil, fmt.Errorf("guest upload folder unavailable")
	}
	return id, tx.Commit(ctx)
}

func safeGuestFilename(raw string) (string, error) {
	name := strings.TrimSpace(path.Base(strings.ReplaceAll(raw, "\\", "/")))
	if name == "" || name == "." || name == ".." || utf8.RuneCountInString(name) > 255 {
		return "", errors.New("invalid file name")
	}
	return name, nil
}

func (handler *Handler) respondGuestUploadError(w http.ResponseWriter, err error) {
	if strings.HasPrefix(err.Error(), "quota:") {
		httputil.RespondError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	var conflict *files.UploadConflictError
	if errors.As(err, &conflict) {
		httputil.RespondError(w, http.StatusConflict, "a file with this name already exists")
		return
	}
	handler.respondError(w, err)
}
