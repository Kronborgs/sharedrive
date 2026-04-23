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
