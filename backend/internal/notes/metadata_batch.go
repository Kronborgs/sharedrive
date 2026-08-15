package notes

import (
	"context"

	"github.com/google/uuid"
)

type Metadata struct {
	ID    uuid.UUID
	Title string
	Type  string
}

// GetOwnedMetadataBatch returns only non-deleted notes owned by the actor.
// It deliberately omits note content and checklist items.
func (service *Service) GetOwnedMetadataBatch(ctx context.Context, ownerID uuid.UUID, ids []uuid.UUID) (map[uuid.UUID]Metadata, error) {
	result := make(map[uuid.UUID]Metadata)
	if len(ids) == 0 {
		return result, nil
	}
	rows, err := service.db.Query(ctx, `SELECT id, title, type FROM notes
		WHERE owner_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`, ownerID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var metadata Metadata
		if err := rows.Scan(&metadata.ID, &metadata.Title, &metadata.Type); err != nil {
			return nil, err
		}
		result[metadata.ID] = metadata
	}
	return result, rows.Err()
}
