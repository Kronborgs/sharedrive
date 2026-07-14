package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	yzip "github.com/yeka/zip"

	"github.com/yourname/privatedrive/internal/files"
)

// RestoreService restores .shdbak archives into the database and on-disk
// storage.  It has no HTTP awareness; it reads from an io.ReaderAt so
// the caller controls how the archive is sourced (temp file, memory, etc.).
type RestoreService struct {
	db      *pgxpool.Pool
	storage *files.Storage
}

// NewRestoreService creates a RestoreService.
func NewRestoreService(db *pgxpool.Pool, storage *files.Storage) *RestoreService {
	return &RestoreService{db: db, storage: storage}
}

// Restore reads a .shdbak archive (size bytes) from r and restores all entries
// to ownerID's account.  rawToken is used to derive the ZIP decryption password.
//
// The operation is fully idempotent: records that already exist by UUID are
// skipped.  A partial success is still reported (see RestoreResult.Skipped).
func (s *RestoreService) Restore(ctx context.Context, r io.ReaderAt, size int64, ownerID uuid.UUID, rawToken string) (*restoreResult, error) {
	zipPwd, err := ZipPassword(rawToken)
	if err != nil {
		return nil, fmt.Errorf("restore: derive zip password: %w", err)
	}

	zr, err := yzip.NewReader(r, size)
	if err != nil {
		return nil, fmt.Errorf("restore: open zip: %w", err)
	}

	// Build a name → entry index for O(1) lookups.
	index := make(map[string]*yzip.File, len(zr.File))
	for _, f := range zr.File {
		index[f.Name] = f
	}

	records, err := loadArchiveRecords(index, zipPwd)
	if err != nil {
		return nil, err
	}

	// Folders first, then files, oldest-first — parent rows must exist before
	// their children are inserted (foreign key constraint on parent_id).
	sort.Slice(records, func(i, j int) bool {
		if records[i].IsFolder != records[j].IsFolder {
			return records[i].IsFolder
		}
		return records[i].CreatedAt.Before(records[j].CreatedAt)
	})

	result := &restoreResult{}
	for _, rec := range records {
		inserted, err := s.restoreRecord(ctx, index, &rec, ownerID, zipPwd)
		if err != nil {
			log.Warn().Err(err).Str("file_id", rec.ID).Msg("restore: skipping record")
			result.Skipped++
			continue
		}
		if !inserted {
			result.Skipped++ // already existed
			continue
		}
		if rec.IsFolder {
			result.FoldersRestored++
		} else {
			result.FilesRestored++
			result.BytesRestored += rec.SizeBytes
		}
	}
	return result, nil
}

// restoreRecord inserts one file/folder DB row and (for files) copies its blob
// from the ZIP index into storage.  Returns (false, nil) when the record already
// exists — the caller counts it as skipped rather than an error.
func (s *RestoreService) restoreRecord(
	ctx context.Context,
	index map[string]*yzip.File,
	rec *archiveFileRecord,
	ownerID uuid.UUID,
	zipPwd string,
) (bool, error) {
	// Always re-assign ownership to the restoring user.
	rec.OwnerID = ownerID.String()

	tag, err := s.db.Exec(ctx,
		`INSERT INTO files
		   (id, parent_id, owner_id, is_folder, name, mime_type,
		    size_bytes, checksum_sha256, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		 ON CONFLICT (id) DO NOTHING`,
		rec.ID, rec.ParentID, rec.OwnerID, rec.IsFolder, rec.Name, nilIfEmpty(rec.MimeType),
		rec.SizeBytes, rec.ChecksumSHA256, rec.CreatedAt, rec.UpdatedAt,
	)
	if err != nil {
		return false, fmt.Errorf("insert record: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return false, nil // already exists — idempotent
	}

	if !rec.IsFolder {
		// v2 archives store the blob at ArchivePath (real folder/filename);
		// v1 archives use "files/{uuid}".  Try ArchivePath first, fall back.
		blobKey := "files/" + rec.ID
		if rec.ArchivePath != "" {
			blobKey = rec.ArchivePath
		}
		entry, ok := index[blobKey]
		if !ok && rec.ArchivePath != "" {
			// Fallback for safety (e.g. hand-edited archive).
			entry, ok = index["files/"+rec.ID]
		}
		if !ok {
			_, _ = s.db.Exec(ctx, `DELETE FROM files WHERE id = $1`, rec.ID)
			return false, fmt.Errorf("blob missing for file %s", rec.ID)
		}
		entry.SetPassword(zipPwd)
		rc, err := entry.Open()
		if err != nil {
			_, _ = s.db.Exec(ctx, `DELETE FROM files WHERE id = $1`, rec.ID)
			return false, fmt.Errorf("open blob %s: %w", rec.ID, err)
		}
		defer rc.Close()

		if _, err := s.storage.Write(rec.ID, rc); err != nil {
			_, _ = s.db.Exec(ctx, `DELETE FROM files WHERE id = $1`, rec.ID)
			return false, fmt.Errorf("write blob %s: %w", rec.ID, err)
		}
	}
	return true, nil
}

func loadArchiveRecords(index map[string]*yzip.File, zipPwd string) ([]archiveFileRecord, error) {
	metaEntry, ok := index["metadata.json"]
	if !ok {
		return nil, fmt.Errorf("restore: archive missing metadata.json")
	}

	metaEntry.SetPassword(zipPwd)
	metaRC, err := metaEntry.Open()
	if err != nil {
		return nil, fmt.Errorf("restore: open metadata.json: %w", err)
	}
	defer metaRC.Close()

	var records []archiveFileRecord
	if err := json.NewDecoder(metaRC).Decode(&records); err != nil {
		return nil, fmt.Errorf("restore: decode metadata.json: %w", err)
	}
	return records, nil
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
