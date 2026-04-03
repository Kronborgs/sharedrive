package files

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TrashService handles soft-delete, restore, and permanent deletion.
type TrashService struct {
	db      *pgxpool.Pool
	storage *Storage
	quota   *QuotaManager
}

// NewTrashService creates a TrashService.
func NewTrashService(db *pgxpool.Pool, storage *Storage) *TrashService {
	return &TrashService{db: db, storage: storage, quota: NewQuotaManager(db)}
}

// SoftDelete marks a file (or folder tree) as deleted by setting deleted_at.
// The storage bytes are retained for the retention period.
func (t *TrashService) SoftDelete(ctx context.Context, id, ownerID string) error {
	result, err := t.db.Exec(ctx,
		`UPDATE files SET deleted_at = now(), updated_at = now()
		 WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
		id, ownerID,
	)
	if err != nil {
		return fmt.Errorf("trash.SoftDelete: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("trash.SoftDelete: not found or access denied")
	}
	return nil
}

// Restore cancels a soft-delete.
func (t *TrashService) Restore(ctx context.Context, id, ownerID string) error {
	result, err := t.db.Exec(ctx,
		`UPDATE files SET deleted_at = NULL, updated_at = now()
		 WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL`,
		id, ownerID,
	)
	if err != nil {
		return fmt.Errorf("trash.Restore: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("trash.Restore: not found or not in trash")
	}
	return nil
}

// PermanentDelete removes the DB record and deletes bytes from disk.
func (t *TrashService) PermanentDelete(ctx context.Context, id, ownerID string) error {
	var sizeBytes int64
	var storagePath *string
	err := t.db.QueryRow(ctx,
		`SELECT size_bytes, storage_path FROM files
		 WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL`,
		id, ownerID,
	).Scan(&sizeBytes, &storagePath)
	if err != nil {
		return fmt.Errorf("trash.PermanentDelete: not found or not in trash")
	}

	if _, err := t.db.Exec(ctx,
		`DELETE FROM files WHERE id = $1 AND owner_id = $2`, id, ownerID,
	); err != nil {
		return fmt.Errorf("trash.PermanentDelete: db: %w", err)
	}

	// Free disk bytes.
	if storagePath != nil && *storagePath != "" {
		_ = t.storage.Delete(id)
	}

	// Reclaim quota.
	if sizeBytes > 0 {
		_ = t.quota.Add(ctx, ownerID, -sizeBytes)
	}
	return nil
}

// ListTrash returns all soft-deleted files for ownerID.
func (t *TrashService) ListTrash(ctx context.Context, ownerID string) ([]*File, error) {
	rows, err := t.db.Query(ctx,
		`SELECT `+fileCols+` FROM files
		 WHERE owner_id = $1 AND deleted_at IS NOT NULL
		 ORDER BY deleted_at DESC`,
		ownerID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []*File
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, rows.Err()
}

// EmptyTrash permanently deletes all trashed files older than retentionDays for ownerID.
func (t *TrashService) EmptyTrash(ctx context.Context, ownerID string, retentionDays int) error {
	cutoff := time.Now().AddDate(0, 0, -retentionDays)

	rows, err := t.db.Query(ctx,
		`SELECT id, size_bytes, storage_path FROM files
		 WHERE owner_id = $1 AND deleted_at IS NOT NULL AND deleted_at < $2`,
		ownerID, cutoff,
	)
	if err != nil {
		return err
	}
	defer rows.Close()

	var toDelete []struct {
		id          string
		sizeBytes   int64
		storagePath *string
	}
	for rows.Next() {
		var item struct {
			id          string
			sizeBytes   int64
			storagePath *string
		}
		if err := rows.Scan(&item.id, &item.sizeBytes, &item.storagePath); err == nil {
			toDelete = append(toDelete, item)
		}
	}

	var totalFreed int64
	for _, item := range toDelete {
		if _, err := t.db.Exec(ctx,
			`DELETE FROM files WHERE id = $1`, item.id,
		); err == nil {
			if item.storagePath != nil && *item.storagePath != "" {
				_ = t.storage.Delete(item.id)
			}
			totalFreed += item.sizeBytes
		}
	}
	if totalFreed > 0 {
		_ = t.quota.Add(ctx, ownerID, -totalFreed)
	}
	return nil
}
