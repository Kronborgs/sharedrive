package rooms

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/yourname/privatedrive/internal/notes"
)

var ErrResourceExists = errors.New("resource is already attached to the room")

type ResourceView struct {
	Resource
	Accessible bool   `json:"accessible"`
	Name       string `json:"name,omitempty"`
	MimeType   string `json:"mime_type,omitempty"`
	IsFolder   bool   `json:"is_folder,omitempty"`
	NoteType   string `json:"note_type,omitempty"`
}

func (service *Service) AddResource(ctx context.Context, actorID, roomID uuid.UUID, resourceType ResourceType, resourceID uuid.UUID) (ResourceView, error) {
	room, err := service.Get(ctx, actorID, roomID)
	if err != nil {
		return ResourceView{}, err
	}
	if !ValidResourceType(resourceType) {
		return ResourceView{}, ErrInvalidRole
	}
	if err := service.authorizeResourceAttach(ctx, actorID, resourceType, resourceID); err != nil {
		return ResourceView{}, err
	}
	tx, err := service.db.Begin(ctx)
	if err != nil {
		return ResourceView{}, err
	}
	defer tx.Rollback(ctx)

	var resource Resource
	err = tx.QueryRow(ctx, `INSERT INTO room_resources (room_id, resource_type, resource_id, added_by)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (room_id, resource_type, resource_id) DO NOTHING
		RETURNING id, room_id, resource_type, resource_id, added_by, created_at`, roomID, resourceType, resourceID, actorID).Scan(
		&resource.ID, &resource.RoomID, &resource.ResourceType, &resource.ResourceID, &resource.AddedBy, &resource.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ResourceView{}, ErrResourceExists
	}
	if err != nil {
		return ResourceView{}, err
	}
	if resourceType == ResourceFile {
		result, shareErr := tx.Exec(ctx, `INSERT INTO shares
			(resource_id, owner_id, grantee_type, grantee_id, can_view, can_upload, can_edit, can_delete, can_reshare, created_by)
			SELECT f.id, f.owner_id, 'group', $2, TRUE, FALSE, FALSE, FALSE, FALSE, $3
			FROM files f
			WHERE f.id = $1 AND f.deleted_at IS NULL
			AND NOT EXISTS (
				SELECT 1 FROM shares existing
				WHERE existing.resource_id = $1 AND existing.grantee_type = 'group'
				AND existing.grantee_id = $2 AND existing.revoked_at IS NULL
			)`, resourceID, room.ManagedGroupID, actorID)
		if shareErr != nil {
			return ResourceView{}, shareErr
		}
		if result.RowsAffected() == 0 {
			var activeShare bool
			shareErr = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM shares
				WHERE resource_id = $1 AND grantee_type = 'group' AND grantee_id = $2 AND revoked_at IS NULL)`,
				resourceID, room.ManagedGroupID).Scan(&activeShare)
			if shareErr != nil || !activeShare {
				return ResourceView{}, ErrNotFound
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ResourceView{}, err
	}
	return service.resolveResource(ctx, actorID, resource)
}
func (service *Service) ListResources(ctx context.Context, actorID, roomID uuid.UUID) ([]ResourceView, error) {
	if _, err := service.Get(ctx, actorID, roomID); err != nil {
		return nil, err
	}
	rows, err := service.db.Query(ctx, `SELECT id, room_id, resource_type, resource_id, added_by, created_at
		FROM room_resources WHERE room_id = $1 ORDER BY created_at DESC, id DESC`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	resources := make([]Resource, 0)
	fileIDs := make([]uuid.UUID, 0)
	noteIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var resource Resource
		if err := rows.Scan(&resource.ID, &resource.RoomID, &resource.ResourceType, &resource.ResourceID, &resource.AddedBy, &resource.CreatedAt); err != nil {
			return nil, err
		}
		resources = append(resources, resource)
		if resource.ResourceType == ResourceFile {
			fileIDs = append(fileIDs, resource.ResourceID)
		} else if resource.ResourceType == ResourceNote {
			noteIDs = append(noteIDs, resource.ResourceID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	filesByID, err := service.fileSvc.GetAccessibleBatch(ctx, fileIDs, actorID)
	if err != nil {
		return nil, err
	}
	notesByID, err := service.noteSvc.GetOwnedMetadataBatch(ctx, actorID, noteIDs)
	if err != nil {
		return nil, err
	}
	result := make([]ResourceView, 0, len(resources))
	for _, resource := range resources {
		view := ResourceView{Resource: resource}
		switch resource.ResourceType {
		case ResourceFile:
			if file := filesByID[resource.ResourceID]; file != nil {
				view.Accessible = true
				view.Name, view.MimeType, view.IsFolder = file.Name, file.MimeType, file.IsFolder
			}
		case ResourceNote:
			if note, ok := notesByID[resource.ResourceID]; ok {
				view.Accessible = true
				view.Name, view.NoteType = note.Title, note.Type
			}
		}
		result = append(result, view)
	}
	return result, nil
}
func (service *Service) RemoveResource(ctx context.Context, actorID, roomID, resourceLinkID uuid.UUID) error {
	room, err := service.Get(ctx, actorID, roomID)
	if err != nil {
		return err
	}
	if room.CurrentRole != RoleOwner && room.CurrentRole != RoleModerator {
		return ErrForbidden
	}
	tx, err := service.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var resourceType ResourceType
	var resourceID uuid.UUID
	err = tx.QueryRow(ctx, `DELETE FROM room_resources WHERE id = $1 AND room_id = $2
		RETURNING resource_type, resource_id`, resourceLinkID, roomID).Scan(&resourceType, &resourceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if resourceType == ResourceFile {
		_, err = tx.Exec(ctx, `UPDATE shares SET revoked_at = now()
			WHERE resource_id = $1 AND grantee_type = 'group' AND grantee_id = $2 AND revoked_at IS NULL`,
			resourceID, room.ManagedGroupID)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func (service *Service) authorizeResourceAttach(ctx context.Context, actorID uuid.UUID, resourceType ResourceType, resourceID uuid.UUID) error {
	switch resourceType {
	case ResourceFile:
		allowed, err := service.fileSvc.CanReshare(ctx, resourceID.String(), actorID.String())
		if err != nil || !allowed {
			return ErrForbidden
		}
		return nil
	case ResourceNote:
		_, err := service.noteSvc.Get(ctx, actorID, resourceID, false)
		if errors.Is(err, notes.ErrNotFound) {
			return ErrForbidden
		}
		return err
	default:
		return ErrForbidden
	}
}

func (service *Service) resolveResource(ctx context.Context, actorID uuid.UUID, resource Resource) (ResourceView, error) {
	view := ResourceView{Resource: resource, Accessible: true}
	switch resource.ResourceType {
	case ResourceFile:
		file, err := service.fileSvc.GetAccessible(ctx, resource.ResourceID.String(), actorID.String())
		if err != nil {
			return ResourceView{}, err
		}
		view.Name, view.MimeType, view.IsFolder = file.Name, file.MimeType, file.IsFolder
	case ResourceNote:
		note, err := service.noteSvc.Get(ctx, actorID, resource.ResourceID, false)
		if err != nil {
			return ResourceView{}, err
		}
		view.Name, view.NoteType = note.Title, note.Type
	default:
		return ResourceView{}, ErrNotFound
	}
	return view, nil
}
