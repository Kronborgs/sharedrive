package files

import (
	"context"

	"github.com/google/uuid"
)

// GetAccessibleBatch resolves file metadata for a set of IDs using the same
// owner, ancestor-share, and owned-parent rules as GetAccessible.
func (s *Service) GetAccessibleBatch(ctx context.Context, ids []uuid.UUID, userID uuid.UUID) (map[uuid.UUID]*File, error) {
	result := make(map[uuid.UUID]*File)
	if len(ids) == 0 {
		return result, nil
	}
	rows, err := s.db.Query(ctx, `WITH RECURSIVE ancestors(root_id, id, parent_id) AS (
		SELECT id, id, parent_id FROM files WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
		UNION ALL
		SELECT a.root_id, f.id, f.parent_id
		FROM files f JOIN ancestors a ON f.id = a.parent_id
		WHERE f.deleted_at IS NULL
	)
	SELECT f.id, f.parent_id, f.owner_id, f.is_folder, f.name, f.mime_type,
		f.size_bytes, f.storage_path, f.deleted_at, f.created_at, f.updated_at
	FROM files f
	WHERE f.id = ANY($1::uuid[]) AND f.deleted_at IS NULL AND (
		f.owner_id = $2
		OR EXISTS (
			SELECT 1 FROM shares sh JOIN ancestors a ON sh.resource_id = a.id
			WHERE a.root_id = f.id AND sh.revoked_at IS NULL
			AND (sh.expires_at IS NULL OR sh.expires_at > now())
			AND ((sh.grantee_type = 'user' AND sh.grantee_id = $2)
				OR (sh.grantee_type = 'group' AND sh.grantee_id IN (
					SELECT group_id FROM group_members WHERE user_id = $2)))
		)
		OR EXISTS (
			SELECT 1 FROM ancestors a JOIN files parent ON parent.id = a.id
			WHERE a.root_id = f.id AND parent.owner_id = $2
			AND parent.is_folder = TRUE AND parent.id != f.id
		)
	)`, ids, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		file, scanErr := scanFile(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result[file.ID] = file
	}
	return result, rows.Err()
}
