package backup

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/files"
)

// Service orchestrates backup exports. It queries the database for file
// metadata and streams an AES-256-encrypted .shdbak archive via Writer.
//
// It depends only on pgxpool and files.Storage; it has no HTTP awareness.
type Service struct {
	db      *pgxpool.Pool
	storage *files.Storage
}

// NewService creates a backup Service.
func NewService(db *pgxpool.Pool, storage *files.Storage) *Service {
	return &Service{db: db, storage: storage}
}

const archiveFilesPrefix = "files/"

func scanArchiveRecords(rows pgx.Rows) ([]archiveFileRecord, error) {
	defer rows.Close()

	records := make([]archiveFileRecord, 0)
	for rows.Next() {
		var rec archiveFileRecord
		if err := rows.Scan(
			&rec.ID, &rec.ParentID, &rec.OwnerID, &rec.IsFolder, &rec.Name, &rec.MimeType,
			&rec.SizeBytes, &rec.ChecksumSHA256, &rec.DeletedAt, &rec.CreatedAt, &rec.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("export: scan: %w", err)
		}
		records = append(records, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("export: rows: %w", err)
	}
	return records, nil
}

func (s *Service) queryExportRecords(ctx context.Context, userID uuid.UUID, folderIDs []uuid.UUID) ([]archiveFileRecord, error) {
	if len(folderIDs) == 0 {
		rows, err := s.db.Query(ctx,
			`SELECT id, parent_id, owner_id, is_folder, name, COALESCE(mime_type, ''),
			        size_bytes, checksum_sha256, deleted_at, created_at, updated_at
			 FROM files
			 WHERE owner_id = $1 AND deleted_at IS NULL
			 ORDER BY is_folder DESC, created_at`,
			userID,
		)
		if err != nil {
			return nil, fmt.Errorf("export: query: %w", err)
		}
		return scanArchiveRecords(rows)
	}

	rows, err := s.db.Query(ctx,
		`WITH RECURSIVE subtree AS (
		   SELECT id FROM files
		   WHERE id = ANY($2) AND owner_id = $1 AND deleted_at IS NULL
		   UNION ALL
		   SELECT f.id FROM files f
		   JOIN subtree s ON f.parent_id = s.id
		   WHERE f.deleted_at IS NULL
		 )
		 SELECT f.id, f.parent_id, f.owner_id, f.is_folder, f.name, COALESCE(f.mime_type, ''),
		        f.size_bytes, f.checksum_sha256, f.deleted_at, f.created_at, f.updated_at
		 FROM files f
		 JOIN subtree s ON f.id = s.id
		 ORDER BY f.is_folder DESC, f.created_at`,
		userID, folderIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("export: query (selective): %w", err)
	}
	return scanArchiveRecords(rows)
}

func countArchiveEntries(records []archiveFileRecord) (fileCount, folderCount int) {
	for _, record := range records {
		if record.IsFolder {
			folderCount++
		} else {
			fileCount++
		}
	}
	return fileCount, folderCount
}

func buildFolderPaths(records []archiveFileRecord, folderCount int) map[string]string {
	folderPath := make(map[string]string, folderCount)
	for _, record := range records {
		if record.IsFolder {
			folderPath[record.ID] = record.Name
		}
	}
	for _, record := range records {
		if record.IsFolder && record.ParentID != nil {
			if parent, ok := folderPath[*record.ParentID]; ok {
				folderPath[record.ID] = parent + "/" + record.Name
			}
		}
	}
	return folderPath
}

func assignArchivePaths(records []archiveFileRecord, folderPath map[string]string) {
	for i := range records {
		record := &records[i]
		if record.IsFolder {
			record.ArchivePath = archiveFilesPrefix + folderPath[record.ID] + "/"
			continue
		}
		if record.ParentID != nil {
			if parent, ok := folderPath[*record.ParentID]; ok {
				record.ArchivePath = archiveFilesPrefix + parent + "/" + record.Name
				continue
			}
		}
		record.ArchivePath = archiveFilesPrefix + record.Name
	}
}

func deduplicateArchivePaths(records []archiveFileRecord) {
	seen := make(map[string]int, len(records))
	for i := range records {
		record := &records[i]
		if record.IsFolder {
			continue
		}
		if prev, ok := seen[record.ArchivePath]; ok {
			if records[prev].ArchivePath == record.ArchivePath {
				records[prev].ArchivePath = record.ArchivePath + "." + records[prev].ID
			}
			record.ArchivePath = record.ArchivePath + "." + record.ID
			continue
		}
		seen[record.ArchivePath] = i
	}
}

func prepareArchiveRecords(records []archiveFileRecord) (int, int) {
	fileCount, folderCount := countArchiveEntries(records)
	folderPath := buildFolderPaths(records, folderCount)
	assignArchivePaths(records, folderPath)
	deduplicateArchivePaths(records)
	return fileCount, folderCount
}

// Export writes an AES-256 encrypted .shdbak archive of all non-deleted files
// owned by userID into w.  The archive password is derived from rawToken via
// HKDF-SHA256 — the token is never stored in the archive.
//
// folderIDs restricts the archive to the specified folders and all their
// recursive descendants; an empty slice exports every file.
//
// Missing blobs are skipped with a warning; they do not abort the export so
// partial archives can still be restored.
func (s *Service) Export(ctx context.Context, w io.Writer, userID uuid.UUID, rawToken string, folderIDs []uuid.UUID) error {
	zipPwd, err := ZipPassword(rawToken)
	if err != nil {
		return fmt.Errorf("export: derive zip password: %w", err)
	}

	records, err := s.queryExportRecords(ctx, userID, folderIDs)
	if err != nil {
		return err
	}
	fileCount, folderCount := prepareArchiveRecords(records)

	zw := NewWriter(w, zipPwd)
	if err := zw.AddJSON("manifest.json", archiveManifest{
		Version:     archiveVersion,
		UserID:      userID.String(),
		CreatedAt:   time.Now().UTC(),
		FileCount:   fileCount,
		FolderCount: folderCount,
	}); err != nil {
		zw.Close() //nolint:errcheck
		return fmt.Errorf("export: manifest: %w", err)
	}
	if err := zw.AddJSON("metadata.json", records); err != nil {
		zw.Close() //nolint:errcheck
		return fmt.Errorf("export: metadata: %w", err)
	}
	if len(folderIDs) == 0 {
		noteRecords, noteErr := s.queryNoteRecords(ctx, userID)
		if noteErr != nil {
			zw.Close() //nolint:errcheck
			return noteErr
		}
		if err := zw.AddJSON("notes.json", noteRecords); err != nil {
			zw.Close() //nolint:errcheck
			return fmt.Errorf("export: notes: %w", err)
		}
	}

	for _, record := range records {
		if record.IsFolder {
			continue
		}
		file, openErr := s.storage.Open(record.ID)
		if openErr != nil {
			log.Warn().Err(openErr).Str("file_id", record.ID).Msg("export: open blob — skipping")
			continue
		}
		if err := zw.AddBlob(record.ArchivePath, file); err != nil {
			file.Close()
			log.Warn().Err(err).Str("file_id", record.ID).Msg("export: write blob — skipping")
			continue
		}
		file.Close()
	}

	if err := zw.Close(); err != nil {
		return fmt.Errorf("export: close zip: %w", err)
	}
	return nil
}

func (s *Service) queryNoteRecords(ctx context.Context, userID uuid.UUID) ([]archiveNoteRecord, error) {
	rows, err := s.db.Query(ctx, `SELECT id, type, title, content, color, is_pinned, is_archived,
		hide_completed, deleted_at, version, created_at, updated_at
		FROM notes WHERE owner_id = $1 ORDER BY created_at`, userID)
	if err != nil {
		return nil, fmt.Errorf("export: query notes: %w", err)
	}
	defer rows.Close()
	records := make([]archiveNoteRecord, 0)
	for rows.Next() {
		var record archiveNoteRecord
		if err := rows.Scan(&record.ID, &record.Type, &record.Title, &record.Content, &record.Color,
			&record.IsPinned, &record.IsArchived, &record.HideCompleted, &record.DeletedAt,
			&record.Version, &record.CreatedAt, &record.UpdatedAt); err != nil {
			return nil, fmt.Errorf("export: scan note: %w", err)
		}
		record.Items, err = s.queryNoteItems(ctx, record.ID)
		if err != nil {
			return nil, err
		}
		record.Shares, err = s.queryNoteShares(ctx, record.ID)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *Service) queryNoteItems(ctx context.Context, noteID string) ([]archiveNoteItem, error) {
	rows, err := s.db.Query(ctx, `SELECT id, content, is_checked, position, created_at, updated_at
		FROM note_items WHERE note_id = $1 ORDER BY position`, noteID)
	if err != nil {
		return nil, fmt.Errorf("export: query note items: %w", err)
	}
	defer rows.Close()
	items := make([]archiveNoteItem, 0)
	for rows.Next() {
		var item archiveNoteItem
		if err := rows.Scan(&item.ID, &item.Content, &item.IsChecked, &item.Position, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) queryNoteShares(ctx context.Context, noteID string) ([]archiveNoteShare, error) {
	rows, err := s.db.Query(ctx, `SELECT id, recipient_email, permission, invitation_token_hash,
		expires_at, revoked_at, last_sent_at, last_opened_at, created_at, updated_at
		FROM note_shares WHERE note_id = $1 ORDER BY created_at`, noteID)
	if err != nil {
		return nil, fmt.Errorf("export: query note shares: %w", err)
	}
	defer rows.Close()
	shares := make([]archiveNoteShare, 0)
	for rows.Next() {
		var share archiveNoteShare
		if err := rows.Scan(&share.ID, &share.RecipientEmail, &share.Permission, &share.InvitationTokenHash,
			&share.ExpiresAt, &share.RevokedAt, &share.LastSentAt, &share.LastOpenedAt,
			&share.CreatedAt, &share.UpdatedAt); err != nil {
			return nil, err
		}
		shares = append(shares, share)
	}
	return shares, rows.Err()
}
