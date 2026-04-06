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
// The actor must own the file OR hold an active share with can_delete=true on
// the file or an ancestor folder.
// When the actor is not the file owner but has delete permission via ancestor
// folder ownership or share, ownership is transferred to the actor so the file
// appears in the actor's trash (not an inaccessible guest trash).
func (t *TrashService) SoftDelete(ctx context.Context, id, ownerID string) error {
	tx, err := t.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("trash.SoftDelete: begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Fetch current owner and size so we can transfer quota if ownership changes.
	var currentOwner string
	var sizeBytes int64
	var isFolder bool
	if err := tx.QueryRow(ctx,
		`SELECT owner_id::text, COALESCE(size_bytes, 0), is_folder
		 FROM files WHERE id = $1::uuid AND deleted_at IS NULL`, id,
	).Scan(&currentOwner, &sizeBytes, &isFolder); err != nil {
		return fmt.Errorf("trash.SoftDelete: not found")
	}

	// Soft-delete and unconditionally set owner_id = actor, subject to
	// permission check. For files the actor already owns this is a no-op on
	// owner_id. For files owned by someone else (e.g. guest-uploaded files in
	// an owned folder) the ownership transfers to the actor so the file
	// appears in the actor's trash.
	result, err := tx.Exec(ctx,
		`UPDATE files SET deleted_at = now(), updated_at = now(), owner_id = $2::uuid
		 WHERE id = $1::uuid AND deleted_at IS NULL
		 AND (
		   owner_id = $2
		   OR EXISTS (
		     SELECT 1 FROM files p WHERE p.id = files.parent_id AND p.owner_id = $2::uuid
		   )
		   OR EXISTS (
		     WITH RECURSIVE anc AS (
		       SELECT id, parent_id FROM files WHERE id = $1::uuid
		       UNION ALL
		       SELECT f.id, f.parent_id FROM files f JOIN anc a ON f.id = a.parent_id WHERE f.deleted_at IS NULL
		     )
		     SELECT 1 FROM shares s JOIN anc a ON a.id = s.resource_id
		     WHERE s.revoked_at IS NULL
		       AND (s.expires_at IS NULL OR s.expires_at > now())
		       AND s.can_delete = true
		       AND (
		         (s.grantee_type = 'user' AND s.grantee_id = $2::uuid)
		         OR (s.grantee_type = 'group' AND s.grantee_id IN (
		           SELECT group_id FROM group_members WHERE user_id = $2::uuid
		         ))
		       )
		   )
		 )`,
		id, ownerID,
	)
	if err != nil {
		return fmt.Errorf("trash.SoftDelete: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("trash.SoftDelete: not found or access denied")
	}

	// Transfer quota allocation when ownership changed (non-folder files only).
	// Decrement the old owner's usage; increment the new owner's so that
	// PermanentDelete can correctly reclaim from the right user later.
	if currentOwner != ownerID && !isFolder && sizeBytes > 0 {
		tx.Exec(ctx,
			`UPDATE users SET quota_used_bytes = GREATEST(0, quota_used_bytes - $1), updated_at = now()
			 WHERE id = $2::uuid`, sizeBytes, currentOwner)
		tx.Exec(ctx,
			`UPDATE users SET quota_used_bytes = quota_used_bytes + $1, updated_at = now()
			 WHERE id = $2::uuid`, sizeBytes, ownerID)
	}

	return tx.Commit(ctx)
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

// EmptyTrashAll permanently deletes every trashed file for ownerID regardless of age.
func (t *TrashService) EmptyTrashAll(ctx context.Context, ownerID string) error {
	rows, err := t.db.Query(ctx,
		`SELECT id, size_bytes, storage_path FROM files
		 WHERE owner_id = $1 AND deleted_at IS NOT NULL`,
		ownerID,
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
		if _, err := t.db.Exec(ctx, `DELETE FROM files WHERE id = $1`, item.id); err == nil {
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
