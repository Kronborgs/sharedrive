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

	var rows pgx.Rows
	if len(folderIDs) == 0 {
		// Export everything owned by this user.
		var err error
		rows, err = s.db.Query(ctx,
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
	} else {
		// Export only the selected folders and their entire recursive subtrees.
		var err error
		rows, err = s.db.Query(ctx,
			`WITH RECURSIVE subtree AS (
			   SELECT id FROM files
			   WHERE id = ANY($2) AND owner_id = $1 AND deleted_at IS NULL
			   UNION ALL
			   SELECT f.id FROM files f
			   JOIN subtree s ON f.parent_id = s.id
			   WHERE f.deleted_at IS NULL
			 )
			 SELECT f.id, f.parent_id, f.owner_id, f.is_folder, f.name, f.mime_type,
			        f.size_bytes, f.checksum_sha256, f.deleted_at, f.created_at, f.updated_at
			 FROM files f
			 JOIN subtree s ON f.id = s.id
			 ORDER BY f.is_folder DESC, f.created_at`,
			userID, folderIDs,
		)
		if err != nil {
			return fmt.Errorf("export: query (selective): %w", err)
		}
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

	// Build folder path lookup: folderID → "Folder/Subfolder/..."
	folderPath := make(map[string]string, folderCount)
	for _, r := range records {
		if r.IsFolder {
			folderPath[r.ID] = r.Name
		}
	}
	// Resolve full paths (parents are ordered first in the query).
	for _, r := range records {
		if r.IsFolder && r.ParentID != nil {
			if parent, ok := folderPath[*r.ParentID]; ok {
				folderPath[r.ID] = parent + "/" + r.Name
			}
		}
	}

	// Assign archive paths: real folder structure with real filenames.
	for i := range records {
		rec := &records[i]
		if rec.IsFolder {
			rec.ArchivePath = "files/" + folderPath[rec.ID] + "/"
		} else if rec.ParentID != nil {
			if parent, ok := folderPath[*rec.ParentID]; ok {
				rec.ArchivePath = "files/" + parent + "/" + rec.Name
			} else {
				rec.ArchivePath = "files/" + rec.Name
			}
		} else {
			rec.ArchivePath = "files/" + rec.Name
		}
	}

	// Deduplicate archive paths: if two files share a name in the same
	// folder, append the UUID to disambiguate.
	seen := make(map[string]int, len(records))
	for i := range records {
		rec := &records[i]
		if rec.IsFolder {
			continue
		}
		if prev, ok := seen[rec.ArchivePath]; ok {
			// Rename the first occurrence too if not yet renamed.
			if records[prev].ArchivePath == rec.ArchivePath {
				records[prev].ArchivePath = rec.ArchivePath + "." + records[prev].ID
			}
			rec.ArchivePath = rec.ArchivePath + "." + rec.ID
		} else {
			seen[rec.ArchivePath] = i
		}
	}

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

	for _, rec := range records {
		if rec.IsFolder {
			continue
		}
		f, err := s.storage.Open(rec.ID)
		if err != nil {
			log.Warn().Err(err).Str("file_id", rec.ID).Msg("export: open blob — skipping")
			continue
		}
		if err := zw.AddBlob(rec.ArchivePath, f); err != nil {
			f.Close()
			log.Warn().Err(err).Str("file_id", rec.ID).Msg("export: write blob — skipping")
			continue
		}
		f.Close()
	}

	// Close MUST be called last — it writes the ZIP central directory.
	// Without it the archive is invalid and cannot be opened by any tool.
	if err := zw.Close(); err != nil {
		return fmt.Errorf("export: close zip: %w", err)
	}
	return nil
}
