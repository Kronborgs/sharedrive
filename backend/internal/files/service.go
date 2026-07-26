package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

// File represents a row in the files table.
type File struct {
	ID          uuid.UUID  `json:"id"`
	ParentID    *uuid.UUID `json:"parent_id,omitempty"`
	OwnerID     uuid.UUID  `json:"owner_id"`
	IsFolder    bool       `json:"is_folder"`
	Name        string     `json:"name"`
	MimeType    string     `json:"mime_type,omitempty"`
	SizeBytes   int64      `json:"size_bytes"`
	StoragePath string     `json:"-"`
	DeletedAt   *time.Time `json:"deleted_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

// UploadConflictError is returned when a file/folder with the same name already
// exists in the destination folder.
type UploadConflictError struct {
	Existing *File
}

var ErrInvalidUploadFolderID = errors.New("invalid upload folder id")

func (e *UploadConflictError) Error() string {
	if e == nil || e.Existing == nil {
		return "upload conflict"
	}
	if e.Existing.IsFolder {
		return "a folder with this name already exists"
	}
	return "a file with this name already exists"
}

// DuplicateHit describes an exact-name match visible to the current user.
type DuplicateHit struct {
	ID        uuid.UUID  `json:"id"`
	ParentID  *uuid.UUID `json:"parent_id,omitempty"`
	OwnerID   uuid.UUID  `json:"owner_id"`
	IsFolder  bool       `json:"is_folder"`
	Name      string     `json:"name"`
	UpdatedAt time.Time  `json:"updated_at"`
	FullPath  string     `json:"full_path"`
}

// nullableString is used to scan nullable TEXT columns into a plain string.
type nullableString struct{ s *string }

func (n *nullableString) Scan(src any) error {
	if src == nil {
		return nil
	}
	if v, ok := src.(string); ok {
		*n.s = v
	}
	return nil
}

// Service provides file-management operations backed by PostgreSQL.
type Service struct {
	db      *pgxpool.Pool
	storage *Storage
	quota   *QuotaManager
}

// NewService creates a Service.
func NewService(db *pgxpool.Pool, storage *Storage) *Service {
	return &Service{
		db:      db,
		storage: storage,
		quota:   NewQuotaManager(db),
	}
}

// AuthorizeParentWrite checks that the user is allowed to write into the given
// parent folder. If parentID is nil the write targets root, which is always
// allowed for the owner. For non-nil parentID the folder must exist, be
// non-deleted, and be owned by ownerID (or the user must hold a share with
// can_edit on it or an ancestor). Returns nil on success.
func (s *Service) AuthorizeParentWrite(ctx context.Context, ownerID string, parentID *uuid.UUID) error {
	if parentID == nil {
		return nil // root — always allowed for authenticated user
	}

	var folderOwner string
	var isFolder bool
	err := s.db.QueryRow(ctx,
		`SELECT owner_id::text, is_folder FROM files
		 WHERE id = $1 AND deleted_at IS NULL`,
		*parentID,
	).Scan(&folderOwner, &isFolder)
	if err != nil {
		return fmt.Errorf("parent folder not found")
	}
	if !isFolder {
		return fmt.Errorf("parent is not a folder")
	}
	if folderOwner == ownerID {
		return nil
	}
	var hasAccess bool
	err = s.db.QueryRow(ctx,
		`WITH RECURSIVE anc AS (
		   SELECT id, parent_id FROM files WHERE id = $1::uuid AND deleted_at IS NULL
		   UNION ALL
		   SELECT f.id, f.parent_id FROM files f JOIN anc a ON f.id = a.parent_id WHERE f.deleted_at IS NULL
		 )
		 SELECT EXISTS (
		   SELECT 1 FROM shares s
		   JOIN anc a ON a.id = s.resource_id
		   WHERE s.revoked_at IS NULL
		     AND (s.expires_at IS NULL OR s.expires_at > now())
		     AND s.can_edit = true
		     AND (
		       (s.grantee_type = 'user' AND s.grantee_id = $2::uuid)
		       OR (s.grantee_type = 'group' AND s.grantee_id IN (
		         SELECT group_id FROM group_members WHERE user_id = $2::uuid
		       ))
		     )
		 )`, *parentID, ownerID,
	).Scan(&hasAccess)
	if err != nil {
		return fmt.Errorf("parent access check failed")
	}
	if !hasAccess {
		return fmt.Errorf("parent folder not writable")
	}
	return nil
}

const fileCols = `id, parent_id, owner_id, is_folder, name, mime_type,
                  size_bytes, storage_path, deleted_at, created_at, updated_at`

func scanFile(row interface {
	Scan(dest ...any) error
}) (*File, error) {
	f := &File{}
	mime := nullableString{&f.MimeType}
	path := nullableString{&f.StoragePath}
	return f, row.Scan(
		&f.ID, &f.ParentID, &f.OwnerID, &f.IsFolder, &f.Name, &mime,
		&f.SizeBytes, &path, &f.DeletedAt, &f.CreatedAt, &f.UpdatedAt,
	)
}

// List returns direct children of parentID for ownerID (nil parentID = root).
// It also includes files uploaded by other users (e.g. guests) into folders
// that are owned by ownerID.
func (s *Service) List(ctx context.Context, ownerID string, parentID *uuid.UUID) ([]*File, error) {
	var rows interface {
		Next() bool
		Scan(dest ...any) error
		Close()
		Err() error
	}
	var err error
	if parentID == nil {
		rows, err = s.db.Query(ctx,
			`SELECT `+fileCols+` FROM files
			 WHERE owner_id = $1 AND parent_id IS NULL AND deleted_at IS NULL
			 ORDER BY is_folder DESC, name ASC`,
			ownerID,
		)
	} else {
		// Show all files in this folder if the folder is owned by the user,
		// otherwise only files owned by the user in this folder.
		rows, err = s.db.Query(ctx,
			`SELECT `+fileCols+` FROM files
			 WHERE parent_id = $2 AND deleted_at IS NULL
			   AND (
			     owner_id = $1
			     OR EXISTS (
			       SELECT 1 FROM files p WHERE p.id = $2 AND p.owner_id = $1
			     )
			   )
			 ORDER BY is_folder DESC, name ASC`,
			ownerID, parentID,
		)
	}
	if err != nil {
		return nil, fmt.Errorf("files.List: %w", err)
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

// Get retrieves a single file visible to ownerID.
func (s *Service) Get(ctx context.Context, id, ownerID string) (*File, error) {
	row := s.db.QueryRow(ctx,
		`SELECT `+fileCols+` FROM files WHERE id = $1 AND owner_id = $2`, id, ownerID,
	)
	return scanFile(row)
}

// GetAccessible retrieves a file if the user owns it OR has an active share grant
// for it or any of its ancestor folders, OR owns an ancestor folder (e.g. a
// folder owner accessing a file uploaded by a guest into their folder).
func (s *Service) GetAccessible(ctx context.Context, id, userID string) (*File, error) {
	row := s.db.QueryRow(ctx,
		`WITH RECURSIVE ancestors AS (
		   SELECT id, parent_id FROM files WHERE id = $1::uuid AND deleted_at IS NULL
		   UNION ALL
		   SELECT f.id, f.parent_id
		   FROM files f
		   JOIN ancestors a ON f.id = a.parent_id
		   WHERE f.deleted_at IS NULL
		 )
		 SELECT `+fileCols+` FROM files
		 WHERE id = $1
		   AND deleted_at IS NULL
		   AND (
		     owner_id = $2
		     OR EXISTS (
		       SELECT 1 FROM shares sh
		       JOIN ancestors anc ON sh.resource_id = anc.id
		       WHERE sh.revoked_at IS NULL
		         AND (sh.expires_at IS NULL OR sh.expires_at > now())
		         AND (
		           (sh.grantee_type = 'user'  AND sh.grantee_id = $2::uuid)
		           OR
		           (sh.grantee_type = 'group' AND sh.grantee_id IN (
		             SELECT group_id FROM group_members WHERE user_id = $2::uuid
		           ))
		         )
		     )
		     OR EXISTS (
		       SELECT 1 FROM ancestors anc
		       JOIN files af ON af.id = anc.id
		       WHERE af.owner_id = $2::uuid
		         AND af.is_folder = true
		         AND af.id != $1::uuid
		     )
		   )`,
		id, userID,
	)
	return scanFile(row)
}

// GetNameByID returns the name of a file by ID, including trashed files.
// Returns an empty string when not found — used for audit log enrichment only.
func (s *Service) GetNameByID(ctx context.Context, id string) string {
	var name string
	_ = s.db.QueryRow(ctx, `SELECT name FROM files WHERE id = $1::uuid`, id).Scan(&name)
	return name
}

// CreateFolder inserts a new folder record.
func (s *Service) CreateFolder(ctx context.Context, ownerID, name string, parentID *uuid.UUID) (*File, error) {
	if err := s.AuthorizeParentWrite(ctx, ownerID, parentID); err != nil {
		return nil, fmt.Errorf("files.CreateFolder: %w", err)
	}
	row := s.db.QueryRow(ctx,
		`INSERT INTO files (owner_id, parent_id, is_folder, name)
		 VALUES ($1, $2, true, $3)
		 RETURNING `+fileCols,
		ownerID, parentID, name,
	)
	f, err := scanFile(row)
	if err != nil {
		return nil, fmt.Errorf("files.CreateFolder: %w", err)
	}
	return f, nil
}

// Rename changes the name of a file/folder. The actor must own the file OR hold
// an active share with can_edit=true on the file or an ancestor folder.
func (s *Service) Rename(ctx context.Context, id, ownerID, newName string) error {
	result, err := s.db.Exec(ctx,
		`UPDATE files SET name = $1, updated_at = now()
		 WHERE id = $2::uuid AND deleted_at IS NULL
		 AND (
		   owner_id = $3::uuid
		   OR EXISTS (
		     WITH RECURSIVE anc AS (
		       SELECT id, parent_id FROM files WHERE id = $2::uuid
		       UNION ALL
		       SELECT f.id, f.parent_id FROM files f JOIN anc a ON f.id = a.parent_id WHERE f.deleted_at IS NULL
		     )
		     SELECT 1 FROM shares s JOIN anc a ON a.id = s.resource_id
		     WHERE s.revoked_at IS NULL
		       AND (s.expires_at IS NULL OR s.expires_at > now())
		       AND s.can_edit = true
		       AND (
		         (s.grantee_type = 'user' AND s.grantee_id = $3::uuid)
		         OR (s.grantee_type = 'group' AND s.grantee_id IN (
		           SELECT group_id FROM group_members WHERE user_id = $3::uuid
		         ))
		       )
		   )
		 )`,
		newName, id, ownerID,
	)
	if err != nil {
		return fmt.Errorf("files.Rename: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("files.Rename: not found or access denied")
	}
	return nil
}

// Move changes the parent of a file/folder.
func (s *Service) Move(ctx context.Context, id, ownerID string, newParentID *uuid.UUID) error {
	// Authorize write into the destination folder
	if err := s.AuthorizeParentWrite(ctx, ownerID, newParentID); err != nil {
		return fmt.Errorf("files.Move: %w", err)
	}
	_, err := s.db.Exec(ctx,
		`UPDATE files SET parent_id = $1, updated_at = now()
		 WHERE id = $2 AND owner_id = $3 AND deleted_at IS NULL`,
		newParentID, id, ownerID,
	)
	return err
}

// Copy duplicates a single file (not a folder) into destParentID (nil = root).
// The copy gets a unique name in the destination by appending " (N)".
func (s *Service) Copy(ctx context.Context, srcID, ownerID string, destParentID *uuid.UUID) (*File, error) {
	// Authorize write into the destination folder
	if err := s.AuthorizeParentWrite(ctx, ownerID, destParentID); err != nil {
		return nil, fmt.Errorf("files.Copy: %w", err)
	}
	// Fetch source file — must be non-deleted, owned by actor, not a folder
	src, err := scanFile(s.db.QueryRow(ctx,
		`SELECT `+fileCols+` FROM files
		 WHERE id = $1::uuid AND owner_id = $2::uuid AND deleted_at IS NULL AND is_folder = false`,
		srcID, ownerID,
	))
	if err != nil {
		return nil, fmt.Errorf("files.Copy: source not found: %w", err)
	}

	// Check quota
	if err := s.quota.Check(ctx, ownerID, src.SizeBytes); err != nil {
		return nil, err
	}

	// Build unique name in destination folder
	newName, err := s.uniqueNameInFolder(ctx, ownerID, src.Name, destParentID)
	if err != nil {
		return nil, fmt.Errorf("files.Copy: unique name: %w", err)
	}

	// Open source blob, stream to new UUID with SHA-256 hashing
	in, err := s.storage.Open(srcID)
	if err != nil {
		return nil, fmt.Errorf("files.Copy: open source: %w", err)
	}
	defer in.Close()

	newID := uuid.New()
	hash := sha256.New()
	n, err := s.storage.Write(newID.String(), io.TeeReader(in, hash))
	if err != nil {
		return nil, fmt.Errorf("files.Copy: storage write: %w", err)
	}
	shaHex := hex.EncodeToString(hash.Sum(nil))
	storagePath := s.storage.Path(newID.String())

	// Insert new file record
	f, err := scanFile(s.db.QueryRow(ctx,
		`INSERT INTO files (id, owner_id, parent_id, is_folder, name, mime_type, size_bytes, storage_path, checksum_sha256)
		 VALUES ($1, $2, $3, false, $4, $5, $6, $7, $8)
		 RETURNING `+fileCols,
		newID, ownerID, destParentID, newName, src.MimeType, n, storagePath, shaHex,
	))
	if err != nil {
		_ = s.storage.Delete(newID.String())
		return nil, fmt.Errorf("files.Copy: db insert: %w", err)
	}

	// Increment quota
	if err := s.quota.Add(ctx, ownerID, n); err != nil {
		log.Warn().Err(err).Str("file_id", newID.String()).Msg("files.Copy: quota update")
	}

	return f, nil
}

// uniqueNameInFolder returns a name that is unique within the folder (parentID,
// nil = root) for ownerID. Tries name as-is; if taken, tries "base (1).ext",
// "base (2).ext", …, up to 999.
func (s *Service) uniqueNameInFolder(ctx context.Context, ownerID, name string, parentID *uuid.UUID) (string, error) {
	rows, err := s.db.Query(ctx,
		`SELECT name FROM files
		 WHERE owner_id = $1::uuid AND parent_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL`,
		ownerID, parentID,
	)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	existing := make(map[string]struct{})
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return "", err
		}
		existing[n] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}

	if _, taken := existing[name]; !taken {
		return name, nil
	}

	base, ext := splitFileNameExt(name)
	for i := 1; i <= 999; i++ {
		candidate := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if _, taken := existing[candidate]; !taken {
			return candidate, nil
		}
	}
	return name + "_copy", nil
}

// splitFileNameExt splits a filename into base and extension (including dot).
// "file.txt" → ("file", ".txt"); "archive.tar.gz" → ("archive.tar", ".gz"); "noext" → ("noext", "")
func splitFileNameExt(name string) (base, ext string) {
	if dot := strings.LastIndex(name, "."); dot > 0 {
		return name[:dot], name[dot:]
	}
	return name, ""
}

// FindNameConflict returns the newest non-deleted item in the target folder
// that has the same name. It returns nil when no conflict exists.
func (s *Service) FindNameConflict(ctx context.Context, name, folderIDStr string) (*File, error) {
	var parentID *uuid.UUID
	if folderIDStr != "" {
		id, err := uuid.Parse(folderIDStr)
		if err == nil {
			parentID = &id
		}
	}
	row := s.db.QueryRow(ctx,
		`SELECT `+fileCols+` FROM files
		 WHERE parent_id IS NOT DISTINCT FROM $1
		   AND name = $2
		   AND deleted_at IS NULL
		 ORDER BY updated_at DESC
		 LIMIT 1`,
		parentID, name,
	)
	f, err := scanFile(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("files.FindNameConflict: %w", err)
	}
	return f, nil
}

func (s *Service) overwriteExistingFile(ctx context.Context, existing *File, mimeType string, r io.Reader, contentLength int64) (*File, error) {
	if existing == nil {
		return nil, fmt.Errorf("files.overwriteExistingFile: missing existing file")
	}
	if existing.IsFolder {
		return nil, &UploadConflictError{Existing: existing}
	}

	oldSize := existing.SizeBytes
	if contentLength > oldSize {
		if err := s.quota.Check(ctx, existing.OwnerID.String(), contentLength-oldSize); err != nil {
			return nil, err
		}
	}

	hash := sha256.New()
	n, err := s.storage.Write(existing.ID.String(), io.TeeReader(r, hash))
	if err != nil {
		return nil, fmt.Errorf("files.overwriteExistingFile: storage write: %w", err)
	}
	shaHex := hex.EncodeToString(hash.Sum(nil))

	if contentLength <= 0 && n > oldSize {
		if err := s.quota.Check(ctx, existing.OwnerID.String(), n-oldSize); err != nil {
			return nil, err
		}
	}

	storagePath := s.storage.Path(existing.ID.String())
	f, err := scanFile(s.db.QueryRow(ctx,
		`UPDATE files
		 SET mime_type = $1,
		     size_bytes = $2,
		     storage_path = $3,
		     checksum_sha256 = $4,
		     updated_at = now()
		 WHERE id = $5::uuid
		 RETURNING `+fileCols,
		mimeType, n, storagePath, shaHex, existing.ID,
	))
	if err != nil {
		return nil, fmt.Errorf("files.overwriteExistingFile: db update: %w", err)
	}

	if delta := n - oldSize; delta != 0 {
		if err := s.quota.Add(ctx, existing.OwnerID.String(), delta); err != nil {
			log.Warn().Err(err).Str("file_id", existing.ID.String()).Msg("files.overwriteExistingFile: quota update")
		}
	}

	return f, nil
}

// GetFolderSize computes the recursive total size and file count of a folder.
// The caller must have access to the folder (ownership or share grant).
func (s *Service) GetFolderSize(ctx context.Context, id, userID string) (sizeBytes int64, fileCount int64, err error) {
	f, err := s.GetAccessible(ctx, id, userID)
	if err != nil || f == nil || !f.IsFolder {
		return 0, 0, fmt.Errorf("folder not found")
	}

	err = s.db.QueryRow(ctx, `
		WITH RECURSIVE tree AS (
		  SELECT id, size_bytes, is_folder FROM files WHERE id = $1::uuid AND deleted_at IS NULL
		  UNION ALL
		  SELECT f.id, f.size_bytes, f.is_folder FROM files f
		    JOIN tree t ON f.parent_id = t.id WHERE f.deleted_at IS NULL
		)
		SELECT COALESCE(SUM(size_bytes),0), COUNT(*) FILTER (WHERE NOT is_folder)
		FROM tree WHERE id != $1::uuid`, id,
	).Scan(&sizeBytes, &fileCount)
	return sizeBytes, fileCount, err
}

// Recent returns the most recently updated non-deleted files for ownerID.
func (s *Service) Recent(ctx context.Context, ownerID string, limit int) ([]*File, error) {
	rows, err := s.db.Query(ctx,
		`SELECT `+fileCols+` FROM files
		 WHERE owner_id = $1 AND deleted_at IS NULL AND is_folder = false
		 ORDER BY updated_at DESC
		 LIMIT $2`,
		ownerID, limit,
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

// Search returns files and folders whose names match the query (case-insensitive).
// Results include files owned by userID and files accessible via active share grants.
func (s *Service) Search(ctx context.Context, userID, query string, limit int) ([]*File, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	// Escape LIKE wildcards in the user-supplied string, then wrap in %…%
	escaped := strings.ReplaceAll(strings.ReplaceAll(query, `\`, `\\`), "%", `\%`)
	escaped = strings.ReplaceAll(escaped, "_", `\_`)
	pattern := "%" + escaped + "%"

	rows, err := s.db.Query(ctx,
		`SELECT DISTINCT `+fileCols+`
		 FROM files
		 WHERE deleted_at IS NULL
		   AND name ILIKE $1 ESCAPE '\'
		   AND (
		     owner_id = $2::uuid
		     OR EXISTS (
		       SELECT 1 FROM shares sh
		       WHERE sh.resource_id = files.id
		         AND sh.revoked_at IS NULL
		         AND (sh.expires_at IS NULL OR sh.expires_at > now())
		         AND (
		           (sh.grantee_type = 'user'  AND sh.grantee_id = $2::uuid)
		           OR (sh.grantee_type = 'group' AND sh.grantee_id IN (
		                SELECT group_id FROM group_members WHERE user_id = $2::uuid
		              ))
		         )
		     )
		   )
		 ORDER BY is_folder DESC, name ASC
		 LIMIT $3`,
		pattern, userID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("files.Search: %w", err)
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

// FindExactNameMatches returns files/folders with an exact name match that are
// visible to the user, together with their full relative folder path.
func (s *Service) FindExactNameMatches(ctx context.Context, userID, name string, limit int) ([]DuplicateHit, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	rows, err := s.db.Query(ctx,
		`WITH RECURSIVE matches AS (
		   SELECT f.id, f.parent_id, f.owner_id, f.is_folder, f.name, f.updated_at,
		          f.name AS full_path, 0 AS depth
		   FROM files f
		   WHERE f.deleted_at IS NULL
		     AND f.name = $2
		     AND (
		       f.owner_id = $1::uuid
		       OR EXISTS (
		         SELECT 1 FROM shares sh
		         WHERE sh.resource_id = f.id
		           AND sh.revoked_at IS NULL
		           AND (sh.expires_at IS NULL OR sh.expires_at > now())
		           AND (
		             (sh.grantee_type = 'user'  AND sh.grantee_id = $1::uuid)
		             OR (sh.grantee_type = 'group' AND sh.grantee_id IN (
		                  SELECT group_id FROM group_members WHERE user_id = $1::uuid
		                ))
		           )
		       )
		     )
		   UNION ALL
		   SELECT m.id, p.parent_id, p.owner_id, p.is_folder, p.name, p.updated_at,
		          p.name || '/' || m.full_path, m.depth + 1
		   FROM matches m
		   JOIN files p ON p.id = m.parent_id
		   WHERE p.deleted_at IS NULL
		 )
		 SELECT DISTINCT ON (id)
		   id, parent_id, owner_id, is_folder, name, updated_at, full_path
		 FROM matches
		 ORDER BY id, depth DESC
		 LIMIT $3`,
		userID, name, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("files.FindExactNameMatches: %w", err)
	}
	defer rows.Close()

	var hits []DuplicateHit
	for rows.Next() {
		var hit DuplicateHit
		if err := rows.Scan(&hit.ID, &hit.ParentID, &hit.OwnerID, &hit.IsFolder, &hit.Name, &hit.UpdatedAt, &hit.FullPath); err != nil {
			return nil, err
		}
		hits = append(hits, hit)
	}
	return hits, rows.Err()
}

// UploadParams describes a new or finalized upload request.
type UploadParams struct {
	OwnerID       string
	Name          string
	MimeType      string
	FolderID      string
	Overwrite     bool
	ContentLength int64
}

func parseUploadParentID(folderIDStr string) (*uuid.UUID, error) {
	folderIDStr = strings.TrimSpace(folderIDStr)
	if folderIDStr == "" {
		return nil, nil
	}
	id, err := uuid.Parse(folderIDStr)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidUploadFolderID, err)
	}
	return &id, nil
}

func (s *Service) authorizeUpload(ctx context.Context, params UploadParams) (*uuid.UUID, error) {
	parentID, err := parseUploadParentID(params.FolderID)
	if err != nil {
		return nil, err
	}
	if err := s.AuthorizeParentWrite(ctx, params.OwnerID, parentID); err != nil {
		return nil, err
	}
	return parentID, nil
}

func (s *Service) resolveUploadConflict(ctx context.Context, params UploadParams, r io.Reader) (*File, bool, error) {
	conflict, err := s.FindNameConflict(ctx, params.Name, params.FolderID)
	if err != nil {
		return nil, true, err
	}
	if conflict == nil {
		return nil, false, nil
	}
	if !params.Overwrite || conflict.IsFolder {
		return nil, true, &UploadConflictError{Existing: conflict}
	}
	file, err := s.overwriteExistingFile(ctx, conflict, params.MimeType, r, params.ContentLength)
	return file, true, err
}

func (s *Service) createUploadedFile(ctx context.Context, op string, params UploadParams, parentID *uuid.UUID, r io.Reader) (*File, error) {
	if params.ContentLength > 0 {
		if err := s.quota.Check(ctx, params.OwnerID, params.ContentLength); err != nil {
			return nil, err
		}
	}

	fileID := uuid.New()
	hash := sha256.New()
	n, err := s.storage.Write(fileID.String(), io.TeeReader(r, hash))
	if err != nil {
		return nil, fmt.Errorf("%s: storage write: %w", op, err)
	}
	if params.ContentLength <= 0 {
		if err := s.quota.Check(ctx, params.OwnerID, n); err != nil {
			_ = s.storage.Delete(fileID.String())
			return nil, err
		}
	}

	shaHex := hex.EncodeToString(hash.Sum(nil))
	storagePath := s.storage.Path(fileID.String())
	f := &File{}
	err = s.db.QueryRow(ctx,
		`INSERT INTO files (id, owner_id, parent_id, is_folder, name, mime_type, size_bytes, storage_path, checksum_sha256)
		 VALUES ($1, $2, $3, false, $4, $5, $6, $7, $8)
		 RETURNING `+fileCols,
		fileID, params.OwnerID, parentID, params.Name, params.MimeType, n, storagePath, shaHex,
	).Scan(
		&f.ID, &f.ParentID, &f.OwnerID, &f.IsFolder, &f.Name, &f.MimeType,
		&f.SizeBytes, &f.StoragePath, &f.DeletedAt, &f.CreatedAt, &f.UpdatedAt,
	)
	if err != nil {
		_ = s.storage.Delete(fileID.String())
		return nil, fmt.Errorf("%s: db insert: %w", op, err)
	}

	if err := s.quota.Add(ctx, params.OwnerID, n); err != nil {
		log.Warn().Err(err).Str("file_id", fileID.String()).Msg(op + ": quota update")
	}
	return f, nil
}

// Upload streams r to storage with SHA-256 hashing, enforces quota, and
// inserts a file record. Pass ContentLength=0 if Content-Length is unknown.
func (s *Service) Upload(ctx context.Context, params UploadParams, r io.Reader) (*File, error) {
	parentID, err := s.authorizeUpload(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("files.Upload: %w", err)
	}
	if file, handled, err := s.resolveUploadConflict(ctx, params, r); handled {
		return file, err
	}
	return s.createUploadedFile(ctx, "files.Upload", params, parentID, r)
}

// CheckQuota returns an error when the user has insufficient quota for addBytes.
func (s *Service) CheckQuota(ctx context.Context, userID string, addBytes int64) error {
	return s.quota.Check(ctx, userID, addBytes)
}

const defaultMaxUploadBytes = 256 * 1024 * 1024 // 256 MB

// GetEffectiveMaxUpload returns the maximum file size (bytes) allowed for this upload.
// For guest users with a folder_id, the folder owner's limit is used instead.
// Falls back to the system_settings value, then 256 MB.
func (s *Service) GetEffectiveMaxUpload(ctx context.Context, userID, role, folderID string) int64 {
	lookupID := userID
	if role == "guest" && folderID != "" {
		// Find folder owner
		var ownerID string
		if err := s.db.QueryRow(ctx,
			`SELECT owner_id::text FROM files WHERE id = $1::uuid AND is_folder = true AND deleted_at IS NULL`,
			folderID,
		).Scan(&ownerID); err == nil && ownerID != "" {
			lookupID = ownerID
		}
	}

	var maxBytes *int64
	_ = s.db.QueryRow(ctx,
		`SELECT max_upload_bytes FROM users WHERE id = $1::uuid`,
		lookupID,
	).Scan(&maxBytes)

	if maxBytes != nil && *maxBytes > 0 {
		return *maxBytes
	}

	// Fall back to system_settings
	var sysVal string
	if err := s.db.QueryRow(ctx,
		`SELECT value FROM system_settings WHERE key = 'max_upload_bytes'`,
	).Scan(&sysVal); err == nil && sysVal != "" {
		if n, err := strconv.ParseInt(sysVal, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return defaultMaxUploadBytes
}

// FinalizeTusUpload moves a completed tus temp file into permanent storage,
// inserts a DB record, updates quota, and cleans up the tus temp files.
func (s *Service) FinalizeTusUpload(ctx context.Context, tempPath string, params UploadParams) (*File, error) {
	defer func() {
		_ = os.Remove(tempPath)
		_ = os.Remove(tempPath + ".info")
	}()

	parentID, err := s.authorizeUpload(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("files.FinalizeTusUpload: %w", err)
	}

	src, err := os.Open(tempPath)
	if err != nil {
		return nil, fmt.Errorf("files.FinalizeTusUpload: open: %w", err)
	}
	defer src.Close()

	if file, handled, err := s.resolveUploadConflict(ctx, params, src); handled {
		return file, err
	}
	return s.createUploadedFile(ctx, "files.FinalizeTusUpload", params, parentID, src)
}

// BreadcrumbItem is a minimal representation used for folder navigation breadcrumbs.
type BreadcrumbItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Breadcrumbs returns the ancestor chain from root to the given folder (root first, folder last).
func (s *Service) Breadcrumbs(ctx context.Context, folderID, ownerID string) ([]BreadcrumbItem, error) {
	rows, err := s.db.Query(ctx, `
		WITH RECURSIVE breadcrumb AS (
			SELECT id::text, name, parent_id, 0 AS depth
			FROM files
			WHERE id = $1::uuid AND owner_id = $2::uuid AND deleted_at IS NULL AND is_folder = true
			UNION ALL
			SELECT f.id::text, f.name, f.parent_id, b.depth + 1
			FROM files f
			INNER JOIN breadcrumb b ON f.id = b.parent_id
			WHERE f.deleted_at IS NULL
		)
		SELECT id, name FROM breadcrumb ORDER BY depth DESC
	`, folderID, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []BreadcrumbItem
	for rows.Next() {
		var item BreadcrumbItem
		if err := rows.Scan(&item.ID, &item.Name); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if items == nil {
		items = []BreadcrumbItem{}
	}
	return items, rows.Err()
}

// ZipEntry is a minimal representation used for bulk ZIP streaming.
type ZipEntry struct {
	ID        string // file UUID
	PathInZip string // relative path within the archive (preserves folder structure)
}

// ListDescendantFiles returns all non-folder, non-deleted descendants of
// folderID with their relative path from the folder root. Access checking for
// each individual file is the caller's responsibility.
func (s *Service) ListDescendantFiles(ctx context.Context, folderID string) ([]ZipEntry, error) {
	rows, err := s.db.Query(ctx, `
		WITH RECURSIVE tree AS (
			SELECT
				f.id::text,
				f.name,
				f.parent_id::text,
				f.is_folder,
				f.deleted_at,
				f.name AS path
			FROM files f
			WHERE f.id = $1::uuid AND f.deleted_at IS NULL
			UNION ALL
			SELECT
				c.id::text,
				c.name,
				c.parent_id::text,
				c.is_folder,
				c.deleted_at,
				tree.path || '/' || c.name
			FROM files c
			JOIN tree ON c.parent_id::text = tree.id
			WHERE c.deleted_at IS NULL
		)
		SELECT id, path
		FROM tree
		WHERE is_folder = false
	`, folderID)
	if err != nil {
		return nil, fmt.Errorf("files.ListDescendantFiles: %w", err)
	}
	defer rows.Close()

	var entries []ZipEntry
	for rows.Next() {
		var e ZipEntry
		if err := rows.Scan(&e.ID, &e.PathInZip); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// ReplaceContent overwrites the stored bytes of an existing file (same ID) and
// updates the DB record. Intended for small metadata files such as playlists.
func (s *Service) ReplaceContent(ctx context.Context, fileID string, r io.Reader) error {
	hash := sha256.New()
	n, err := s.storage.Write(fileID, io.TeeReader(r, hash))
	if err != nil {
		return fmt.Errorf("files.ReplaceContent: storage write: %w", err)
	}
	shaHex := hex.EncodeToString(hash.Sum(nil))
	_, err = s.db.Exec(ctx,
		`UPDATE files SET size_bytes = $1, checksum_sha256 = $2, updated_at = now() WHERE id = $3::uuid`,
		n, shaHex, fileID,
	)
	return err
}

// PlaylistMaxTracks returns the configured playlist track limit from
// system_settings, falling back to 200 when unset.
func (s *Service) PlaylistMaxTracks(ctx context.Context) int {
	var val string
	if err := s.db.QueryRow(ctx,
		`SELECT value FROM system_settings WHERE key = 'playlist_max_tracks'`,
	).Scan(&val); err == nil && val != "" {
		if n, err2 := strconv.Atoi(val); err2 == nil && n > 0 {
			return n
		}
	}
	return 200
}

// EnsurePlaylistFolder returns the ID of the user's "Playlister" root folder,
// creating it if it does not yet exist. Returns the folder UUID as a string.
func (s *Service) EnsurePlaylistFolder(ctx context.Context, ownerID string) (string, error) {
	const folderName = "Playlister"

	// Check whether the folder already exists at root for this user.
	var folderID string
	err := s.db.QueryRow(ctx,
		`SELECT id::text FROM files
		 WHERE owner_id = $1::uuid AND parent_id IS NULL AND is_folder = true
		   AND name = $2 AND deleted_at IS NULL
		 LIMIT 1`,
		ownerID, folderName,
	).Scan(&folderID)
	if err == nil {
		return folderID, nil // already exists
	}

	// Create the folder at root.
	f, err := s.CreateFolder(ctx, ownerID, folderName, nil)
	if err != nil {
		return "", fmt.Errorf("EnsurePlaylistFolder: %w", err)
	}
	return f.ID.String(), nil
}
