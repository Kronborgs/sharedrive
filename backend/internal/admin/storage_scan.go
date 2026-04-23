package admin

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

// corruptFile describes a file whose stored bytes do not match an expected
// image format, or whose file content starts with an HTML/text error page.
type corruptFile struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	OwnerID   string    `json:"owner_id"`
	OwnerName string    `json:"owner_name"`
	SizeBytes int64     `json:"size_bytes"`
	MimeType  string    `json:"mime_type"`
	UpdatedAt time.Time `json:"updated_at"`
}

type storageScanResult struct {
	ScannedFiles int           `json:"scanned_files"`
	CorruptFiles []corruptFile `json:"corrupt_files"`
	DurationMs   int64         `json:"duration_ms"`
}

// StorageScan handles POST /api/v1/admin/storage/scan
// Reads the first 16 bytes of every image file on disk and checks whether
// the magic bytes match a known image format. Files that contain HTML/text
// error pages (from a failed WebDAV migration) are returned as corrupt.
func (h *Handler) StorageScan(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	limitStr := r.URL.Query().Get("limit")
	limit := 5000
	if v, err := strconv.Atoi(limitStr); err == nil && v > 0 && v <= 50000 {
		limit = v
	}

	rows, err := h.db.Query(r.Context(),
		`SELECT f.id, f.name, f.owner_id, f.size_bytes, COALESCE(f.mime_type,'') AS mime_type,
		        f.updated_at, COALESCE(u.email, '') AS owner_email
		 FROM files f
		 LEFT JOIN users u ON u.id = f.owner_id
		 WHERE f.is_folder = false
		   AND f.deleted_at IS NULL
		   AND (
		         f.mime_type ILIKE 'image/%'
		      OR f.mime_type = ''
		      OR f.mime_type IS NULL
		      OR f.mime_type = 'application/octet-stream'
		   )
		 ORDER BY f.size_bytes ASC
		 LIMIT $1`,
		limit,
	)
	if err != nil {
		log.Error().Err(err).Msg("admin.StorageScan: query files")
		httputil.RespondError(w, http.StatusInternalServerError, "database error")
		return
	}
	defer rows.Close()

	type row struct {
		id, name, ownerID, mimeType, ownerEmail string
		size                                    int64
		updatedAt                               time.Time
	}
	var candidates []row
	for rows.Next() {
		var ro row
		if err := rows.Scan(&ro.id, &ro.name, &ro.ownerID, &ro.size, &ro.mimeType, &ro.updatedAt, &ro.ownerEmail); err != nil {
			continue
		}
		candidates = append(candidates, ro)
	}
	rows.Close()

	corrupt := make([]corruptFile, 0)
	filesRoot := h.cfg.FilesRoot

	for _, c := range candidates {
		path := scanStoragePath(filesRoot, c.id)
		magic, err := readMagicBytes(path)
		if err != nil {
			// File missing on disk — skip (handled by storage scrub)
			continue
		}
		if !isValidImageMagic(magic) && looksLikeTextOrHTML(magic) {
			corrupt = append(corrupt, corruptFile{
				ID:        c.id,
				Name:      c.name,
				OwnerID:   c.ownerID,
				OwnerName: c.ownerEmail,
				SizeBytes: c.size,
				MimeType:  c.mimeType,
				UpdatedAt: c.updatedAt,
			})
		}
	}

	httputil.Respond(w, http.StatusOK, storageScanResult{
		ScannedFiles: len(candidates),
		CorruptFiles: corrupt,
		DurationMs:   time.Since(start).Milliseconds(),
	})
}

// StoragePurgeCorrupt handles POST /api/v1/admin/storage/purge-corrupt
// Soft-deletes the DB records AND removes the physical files from disk.
// Accepts a JSON body: { "ids": ["uuid1", "uuid2", ...] }
func (h *Handler) StoragePurgeCorrupt(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.IDs) == 0 {
		httputil.RespondError(w, http.StatusBadRequest, "ids array required")
		return
	}
	if len(req.IDs) > 10000 {
		httputil.RespondError(w, http.StatusBadRequest, "too many ids")
		return
	}

	// Soft-delete DB records first so the files are invisible to users
	// even if the disk removal below partially fails.
	tag, err := h.db.Exec(r.Context(),
		`UPDATE files SET deleted_at = NOW()
		 WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
		req.IDs,
	)
	if err != nil {
		log.Error().Err(err).Msg("admin.StoragePurgeCorrupt: update")
		httputil.RespondError(w, http.StatusInternalServerError, "database error")
		return
	}

	// Remove the physical files from disk. Errors are logged but do not fail
	// the request — the DB record is already gone, and a subsequent storage
	// scrub will clean up any orphaned files.
	diskDeleted := 0
	for _, id := range req.IDs {
		path := scanStoragePath(h.cfg.FilesRoot, id)
		if err := os.Remove(path); err != nil {
			if !os.IsNotExist(err) {
				log.Warn().Err(err).Str("id", id).Msg("admin.StoragePurgeCorrupt: remove disk file")
			}
		} else {
			diskDeleted++
		}
	}

	httputil.Respond(w, http.StatusOK, map[string]any{
		"deleted":      tag.RowsAffected(),
		"disk_deleted": diskDeleted,
	})
}

// ── helpers ───────────────────────────────────────────────────────────────────

func scanStoragePath(root, id string) string {
	if len(id) < 2 {
		return filepath.Join(root, "00", id)
	}
	return filepath.Join(root, id[:2], id)
}

func readMagicBytes(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, 16)
	n, err := f.Read(buf)
	if err != nil || n == 0 {
		return nil, err
	}
	return buf[:n], nil
}

// isValidImageMagic returns true when the bytes start with a known image magic.
func isValidImageMagic(b []byte) bool {
	if len(b) < 2 {
		return false
	}
	// JPEG: FF D8
	if b[0] == 0xFF && b[1] == 0xD8 {
		return true
	}
	// PNG: 89 50 4E 47
	if len(b) >= 4 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47 {
		return true
	}
	// GIF: 47 49 46
	if len(b) >= 3 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F' {
		return true
	}
	// WEBP: RIFF....WEBP
	if len(b) >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' &&
		b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P' {
		return true
	}
	// BMP: 42 4D
	if b[0] == 0x42 && b[1] == 0x4D {
		return true
	}
	// TIFF: 49 49 / 4D 4D
	if len(b) >= 4 && ((b[0] == 0x49 && b[1] == 0x49) || (b[0] == 0x4D && b[1] == 0x4D)) {
		return true
	}
	return false
}

// looksLikeTextOrHTML returns true when the bytes look like a text/HTML page
// (i.e. an HTTP error response saved during a failed WebDAV migration).
func looksLikeTextOrHTML(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	// HTML: starts with < or whitespace+<
	for _, c := range b[:min16(len(b))] {
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			continue
		}
		return c == '<' || (c >= 0x20 && c < 0x7F) // printable ASCII = text
	}
	return false
}

func min16(n int) int {
	if n < 16 {
		return n
	}
	return 16
}

// ── Orphan file scan ──────────────────────────────────────────────────────────

// orphanFile describes a physical file on disk that has no matching DB record.
type orphanFile struct {
	Path      string    `json:"path"` // relative shard path, e.g. "ab/abcd1234-..."
	ID        string    `json:"id"`   // UUID = filename on disk
	SizeBytes int64     `json:"size_bytes"`
	ModTime   time.Time `json:"mod_time"`
}

type orphanScanResult struct {
	ScannedBlobs int          `json:"scanned_blobs"`
	OrphanFiles  []orphanFile `json:"orphan_files"`
	DurationMs   int64        `json:"duration_ms"`
}

// StorageScanOrphans handles POST /api/v1/admin/storage/scan-orphans
// Walks the files root directory and returns physical blobs that have no
// matching record in the files table (i.e. are not referenced by any file).
func (h *Handler) StorageScanOrphans(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	filesRoot := h.cfg.FilesRoot

	// 1. Walk disk — collect all UUID-named blobs.
	type blob struct {
		id      string
		relPath string
		size    int64
		modTime time.Time
	}
	var blobs []blob

	shards, err := os.ReadDir(filesRoot)
	if err != nil {
		log.Error().Err(err).Msg("admin.StorageScanOrphans: read root")
		httputil.RespondError(w, http.StatusInternalServerError, "cannot read storage root")
		return
	}
	for _, shard := range shards {
		if !shard.IsDir() || len(shard.Name()) != 2 {
			continue
		}
		shardPath := filepath.Join(filesRoot, shard.Name())
		entries, err := os.ReadDir(shardPath)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || len(e.Name()) != 36 {
				continue // skip non-UUID filenames
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			blobs = append(blobs, blob{
				id:      e.Name(),
				relPath: shard.Name() + "/" + e.Name(),
				size:    info.Size(),
				modTime: info.ModTime(),
			})
		}
	}

	// 2. Check DB in batches of 500.
	const batchSize = 500
	orphans := make([]orphanFile, 0)

	for i := 0; i < len(blobs); i += batchSize {
		end := i + batchSize
		if end > len(blobs) {
			end = len(blobs)
		}
		batch := blobs[i:end]

		ids := make([]string, len(batch))
		for j, b := range batch {
			ids[j] = b.id
		}

		rows, err := h.db.Query(r.Context(),
			`SELECT id::text FROM files WHERE id = ANY($1::uuid[])`,
			ids,
		)
		if err != nil {
			log.Error().Err(err).Msg("admin.StorageScanOrphans: db query")
			httputil.RespondError(w, http.StatusInternalServerError, "database error")
			return
		}
		known := make(map[string]struct{}, len(batch))
		for rows.Next() {
			var id string
			if scanErr := rows.Scan(&id); scanErr == nil {
				known[id] = struct{}{}
			}
		}
		rows.Close()

		for _, b := range batch {
			if _, exists := known[b.id]; !exists {
				orphans = append(orphans, orphanFile{
					Path:      b.relPath,
					ID:        b.id,
					SizeBytes: b.size,
					ModTime:   b.modTime,
				})
			}
		}
	}

	httputil.Respond(w, http.StatusOK, orphanScanResult{
		ScannedBlobs: len(blobs),
		OrphanFiles:  orphans,
		DurationMs:   time.Since(start).Milliseconds(),
	})
}

// StoragePurgeOrphans handles POST /api/v1/admin/storage/purge-orphans
// Permanently deletes the physical blobs identified as orphans.
// Accepts a JSON body: { "ids": ["uuid1", "uuid2", ...] }
func (h *Handler) StoragePurgeOrphans(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.IDs) == 0 {
		httputil.RespondError(w, http.StatusBadRequest, "ids array required")
		return
	}
	if len(req.IDs) > 10000 {
		httputil.RespondError(w, http.StatusBadRequest, "too many ids")
		return
	}

	filesRoot := h.cfg.FilesRoot
	deleted := 0
	freedBytes := int64(0)

	for _, id := range req.IDs {
		// Validate: must look like a UUID (36 chars) to prevent path traversal.
		if len(id) != 36 {
			continue
		}
		path := scanStoragePath(filesRoot, id)
		info, err := os.Stat(path)
		if err != nil {
			if !os.IsNotExist(err) {
				log.Warn().Err(err).Str("id", id).Msg("admin.StoragePurgeOrphans: stat")
			}
			continue
		}
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			log.Warn().Err(err).Str("id", id).Msg("admin.StoragePurgeOrphans: remove")
			continue
		}
		deleted++
		freedBytes += info.Size()
	}

	httputil.Respond(w, http.StatusOK, map[string]any{
		"deleted":     deleted,
		"freed_bytes": freedBytes,
	})
}

// StorageRestoreOrphans handles POST /api/v1/admin/storage/restore-orphans
// Creates file records for orphan blobs so they appear in the calling admin's
// file browser inside a "Restored from cleanup" folder at their root.
// Accepts a JSON body: { "ids": ["uuid1", ...] }
func (h *Handler) StorageRestoreOrphans(w http.ResponseWriter, r *http.Request) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.IDs) == 0 {
		httputil.RespondError(w, http.StatusBadRequest, "ids array required")
		return
	}
	if len(req.IDs) > 10000 {
		httputil.RespondError(w, http.StatusBadRequest, "too many ids")
		return
	}

	actor := middleware.UserFromContext(r.Context())
	if actor == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	ownerID := actor.ID.String()

	// Find or create the "Restored from cleanup" folder at root (parent_id IS NULL).
	const folderName = "Restored from cleanup"
	var folderID string
	err := h.db.QueryRow(r.Context(),
		`SELECT id::text FROM files
		 WHERE owner_id = $1::uuid
		   AND is_folder = true
		   AND name = $2
		   AND parent_id IS NULL
		   AND deleted_at IS NULL
		 LIMIT 1`,
		ownerID, folderName,
	).Scan(&folderID)
	if err != nil {
		// Folder doesn't exist yet — create it.
		if scanErr := h.db.QueryRow(r.Context(),
			`INSERT INTO files (owner_id, parent_id, is_folder, name)
			 VALUES ($1::uuid, NULL, true, $2)
			 RETURNING id::text`,
			ownerID, folderName,
		).Scan(&folderID); scanErr != nil {
			log.Error().Err(scanErr).Msg("admin.StorageRestoreOrphans: create folder")
			httputil.RespondError(w, http.StatusInternalServerError, "could not create restore folder")
			return
		}
	}

	filesRoot := h.cfg.FilesRoot
	restored := 0
	skipped := 0

	for _, id := range req.IDs {
		// Validate UUID length to prevent path traversal.
		if len(id) != 36 {
			skipped++
			continue
		}
		physPath := scanStoragePath(filesRoot, id)
		info, err := os.Stat(physPath)
		if err != nil {
			log.Warn().Err(err).Str("id", id).Msg("admin.StorageRestoreOrphans: stat")
			skipped++
			continue
		}

		// Detect MIME type from the first 512 bytes.
		mimeType := "application/octet-stream"
		if magic, err := readMagicBytes(physPath); err == nil {
			// Read 512 bytes for http.DetectContentType
			buf := make([]byte, 512)
			if f, err := os.Open(physPath); err == nil {
				n, _ := f.Read(buf)
				f.Close()
				if n > 0 {
					mimeType = http.DetectContentType(buf[:n])
				}
				_ = magic // readMagicBytes already opened it; reuse buf here
			}
		}

		// Use the UUID as filename — no better name is available for orphan blobs.
		fileName := id

		_, insertErr := h.db.Exec(r.Context(),
			`INSERT INTO files (id, owner_id, parent_id, is_folder, name, mime_type, size_bytes, storage_path)
			 VALUES ($1::uuid, $2::uuid, $3::uuid, false, $4, $5, $6, $7)
			 ON CONFLICT (id) DO NOTHING`,
			id, ownerID, folderID, fileName, mimeType, info.Size(), physPath,
		)
		if insertErr != nil {
			log.Warn().Err(insertErr).Str("id", id).Msg("admin.StorageRestoreOrphans: insert")
			skipped++
			continue
		}
		restored++
	}

	httputil.Respond(w, http.StatusOK, map[string]any{
		"restored":  restored,
		"skipped":   skipped,
		"folder_id": folderID,
	})
}
