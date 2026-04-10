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
//
// Ownership transfer rule: the deleted file always lands in the PARENT FOLDER
// owner's trash. This means guest-uploaded files are transferred to the folder
// owner's trash, not the guest's (guests have no trash).
func (t *TrashService) SoftDelete(ctx context.Context, id, actorID string) error {
	tx, err := t.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("trash.SoftDelete: begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Fetch current owner, parent folder owner, size, and type so we can
	// determine where the file should land in trash and fix quota.
	var currentOwner string
	var parentOwner *string
	var sizeBytes int64
	var isFolder bool
	if err := tx.QueryRow(ctx,
		`SELECT f.owner_id::text,
		        p.owner_id::text,
		        COALESCE(f.size_bytes, 0),
		        f.is_folder
		 FROM files f
		 LEFT JOIN files p ON p.id = f.parent_id AND p.deleted_at IS NULL
		 WHERE f.id = $1::uuid AND f.deleted_at IS NULL`, id,
	).Scan(&currentOwner, &parentOwner, &sizeBytes, &isFolder); err != nil {
		return fmt.Errorf("trash.SoftDelete: not found")
	}

	// The file will be owned by the parent folder's owner after deletion.
	// If there is no parent (root-level file) the current owner is kept.
	trashOwner := currentOwner
	if parentOwner != nil {
		trashOwner = *parentOwner
	}

	result, err := tx.Exec(ctx,
		`UPDATE files SET deleted_at = now(), updated_at = now(), owner_id = $3::uuid
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
		id, actorID, trashOwner,
	)
	if err != nil {
		return fmt.Errorf("trash.SoftDelete: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("trash.SoftDelete: not found or access denied")
	}

	// For folders: cascade deleted_at to all descendants so they appear in
	// trash and are cleaned up properly when the trash is emptied.
	if isFolder {
		// Sum sizes of all descendants for quota adjustment.
		var childrenSize int64
		tx.QueryRow(ctx, `
			WITH RECURSIVE descendants AS (
			  SELECT id, size_bytes FROM files WHERE parent_id = $1::uuid AND deleted_at IS NULL
			  UNION ALL
			  SELECT f.id, f.size_bytes FROM files f
			    JOIN descendants d ON f.parent_id = d.id WHERE f.deleted_at IS NULL
			)
			SELECT COALESCE(SUM(size_bytes), 0) FROM descendants WHERE size_bytes IS NOT NULL`, id,
		).Scan(&childrenSize)

		// Mark all descendants deleted and assign them to the same trash owner.
		tx.Exec(ctx, `
			WITH RECURSIVE descendants AS (
			  SELECT id FROM files WHERE parent_id = $1::uuid AND deleted_at IS NULL
			  UNION ALL
			  SELECT f.id FROM files f
			    JOIN descendants d ON f.parent_id = d.id WHERE f.deleted_at IS NULL
			)
			UPDATE files SET deleted_at = now(), updated_at = now(), owner_id = $2::uuid
			WHERE id IN (SELECT id FROM descendants)`, id, trashOwner)

		// Adjust quota for all descendants.
		if currentOwner != trashOwner && childrenSize > 0 {
			tx.Exec(ctx,
				`UPDATE users SET quota_used_bytes = GREATEST(0, quota_used_bytes - $1), updated_at = now()
				 WHERE id = $2::uuid`, childrenSize, currentOwner)
			tx.Exec(ctx,
				`UPDATE users SET quota_used_bytes = quota_used_bytes + $1, updated_at = now()
				 WHERE id = $2::uuid`, childrenSize, trashOwner)
		}
	}

	// Fix quota when ownership changed (non-folder files only).
	// Decrement old owner; increment new owner so PermanentDelete reclaims correctly.
	if currentOwner != trashOwner && !isFolder && sizeBytes > 0 {
		tx.Exec(ctx,
			`UPDATE users SET quota_used_bytes = GREATEST(0, quota_used_bytes - $1), updated_at = now()
			 WHERE id = $2::uuid`, sizeBytes, currentOwner)
		tx.Exec(ctx,
			`UPDATE users SET quota_used_bytes = quota_used_bytes + $1, updated_at = now()
			 WHERE id = $2::uuid`, sizeBytes, trashOwner)
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

	// Collect trashed files + any orphaned descendants (children of deleted folders
	// that weren't cascaded by an older version of SoftDelete).
	rows, err := t.db.Query(ctx, `
		WITH RECURSIVE trashed AS (
		  SELECT id, size_bytes, storage_path FROM files
		  WHERE owner_id = $1 AND deleted_at IS NOT NULL AND deleted_at < $2
		  UNION ALL
		  SELECT f.id, f.size_bytes, f.storage_path FROM files f
		    JOIN trashed t ON f.parent_id = t.id WHERE f.deleted_at IS NULL
		)
		SELECT id, COALESCE(size_bytes,0), storage_path FROM trashed`,
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
	rows.Close()

	var totalFreed int64
	for _, item := range toDelete {
		if _, err := t.db.Exec(ctx,
			`DELETE FROM files WHERE id = $1`, item.id,
		); err == nil {
			_ = t.storage.Delete(item.id)
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
	// Collect trashed files + any orphaned descendants (children of deleted folders
	// that weren't cascaded by an older version of SoftDelete).
	rows, err := t.db.Query(ctx, `
		WITH RECURSIVE trashed AS (
		  SELECT id, size_bytes, storage_path FROM files
		  WHERE owner_id = $1 AND deleted_at IS NOT NULL
		  UNION ALL
		  SELECT f.id, f.size_bytes, f.storage_path FROM files f
		    JOIN trashed t ON f.parent_id = t.id WHERE f.deleted_at IS NULL
		)
		SELECT id, COALESCE(size_bytes,0), storage_path FROM trashed`,
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
	rows.Close()

	var totalFreed int64
	for _, item := range toDelete {
		if _, err := t.db.Exec(ctx, `DELETE FROM files WHERE id = $1`, item.id); err == nil {
			_ = t.storage.Delete(item.id)
			totalFreed += item.sizeBytes
		}
	}
	if totalFreed > 0 {
		_ = t.quota.Add(ctx, ownerID, -totalFreed)
	}
	return nil
}
