package backup

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"
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

// Export writes an AES-256 encrypted .shdbak archive of all non-deleted files
// owned by userID into w.  The archive password is derived from rawToken via
// HKDF-SHA256 — the token is never stored in the archive.
//
// Missing blobs are skipped with a warning; they do not abort the export so
// partial archives can still be restored.
func (s *Service) Export(ctx context.Context, w io.Writer, userID uuid.UUID, rawToken string) error {
	zipPwd, err := ZipPassword(rawToken)
	if err != nil {
		return fmt.Errorf("export: derive zip password: %w", err)
	}

	rows, err := s.db.Query(ctx,
		`SELECT id, parent_id, owner_id, is_folder, name, mime_type,
		        size_bytes, checksum_sha256, deleted_at, created_at, updated_at
		 FROM files
		 WHERE owner_id = $1 AND deleted_at IS NULL
		 ORDER BY is_folder DESC, created_at`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("export: query: %w", err)
	}
	defer rows.Close()

	var records []archiveFileRecord
	for rows.Next() {
		var rec archiveFileRecord
		if err := rows.Scan(
			&rec.ID, &rec.ParentID, &rec.OwnerID, &rec.IsFolder, &rec.Name, &rec.MimeType,
			&rec.SizeBytes, &rec.ChecksumSHA256, &rec.DeletedAt, &rec.CreatedAt, &rec.UpdatedAt,
		); err != nil {
			return fmt.Errorf("export: scan: %w", err)
		}
		records = append(records, rec)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("export: rows: %w", err)
	}

	var fileCount, folderCount int
	for _, r := range records {
		if r.IsFolder {
			folderCount++
		} else {
			fileCount++
		}
	}

	zw := NewWriter(w, zipPwd)
	defer zw.Close()

	if err := zw.AddJSON("manifest.json", archiveManifest{
		Version:     archiveVersion,
		UserID:      userID.String(),
		CreatedAt:   time.Now().UTC(),
		FileCount:   fileCount,
		FolderCount: folderCount,
	}); err != nil {
		return fmt.Errorf("export: manifest: %w", err)
	}

	if err := zw.AddJSON("metadata.json", records); err != nil {
		return fmt.Errorf("export: metadata: %w", err)
	}

	for _, rec := range records {
		if rec.IsFolder {
			continue
		}
		f, err := s.storage.Open(rec.ID)
		if err != nil {
			log.Warn().Err(err).Str("file_id", rec.ID).Msg("export: open blob — skipping")
			continue
		}
		if err := zw.AddBlob("files/"+rec.ID, f); err != nil {
			f.Close()
			log.Warn().Err(err).Str("file_id", rec.ID).Msg("export: write blob — skipping")
			continue
		}
		f.Close()
	}

	return nil
}
