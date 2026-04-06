package webdav

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	gowebdav "golang.org/x/net/webdav"
)

// AuthDAVServer handles WebDAV requests authenticated via HTTP Basic Auth
// (email + app password). Mounted at /dav.
//
// Windows: Map Network Drive → https://<host>/dav/<userID>
// macOS Finder: Connect to Server → https://<host>/dav/<userID>
type AuthDAVServer struct {
	db        *pgxpool.Pool
	filesRoot string
	locks     gowebdav.LockSystem // shared across requests so LOCK tokens survive to PUT
}

func NewAuthDAVServer(db *pgxpool.Pool, filesRoot string) *AuthDAVServer {
	return &AuthDAVServer{
		db:        db,
		filesRoot: filesRoot,
		locks:     gowebdav.NewMemLS(),
	}
}

func (s *AuthDAVServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Always advertise DAV capability — Windows WebClient reads these headers
	// from the OPTIONS response before it ever sends credentials.
	w.Header().Set("MS-Author-Via", "DAV")
	w.Header().Set("DAV", "1, 2")

	// OPTIONS answered without auth so Windows WebClient / macOS Finder can
	// discover WebDAV support before prompting for a password.
	if r.Method == http.MethodOptions {
		w.Header().Set("Allow", "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK")
		w.WriteHeader(http.StatusOK)
		return
	}

	// Extract the user ID from the URL: /dav/{userID}[/...]
	// The userID segment makes each user's DAV root distinct and lets Windows
	// resolve the network location to a concrete path.
	trimmed := strings.TrimPrefix(r.URL.Path, "/dav/")
	urlUserID := strings.SplitN(trimmed, "/", 2)[0]
	if urlUserID == "" {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}

	email, password, ok := r.BasicAuth()
	if !ok || email == "" || password == "" {
		w.Header().Set("WWW-Authenticate", `Basic realm="Sharedrive"`)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	userID, err := ValidateAppPassword(r.Context(), s.db, email, password)
	if err != nil || userID != urlUserID {
		w.Header().Set("WWW-Authenticate", `Basic realm="Sharedrive"`)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	h := &gowebdav.Handler{
		Prefix:     "/dav/" + userID,
		FileSystem: &userFS{db: s.db, filesRoot: s.filesRoot, userID: userID},
		LockSystem: s.locks,
		Logger: func(r *http.Request, err error) {
			if err != nil {
				log.Debug().Err(err).
					Str("method", r.Method).
					Str("path", r.URL.Path).
					Msg("webdav")
			}
		},
	}
	h.ServeHTTP(w, r)
}

// ── FileSystem ────────────────────────────────────────────────────────────────

// userFS implements webdav.FileSystem backed by PostgreSQL + sharded disk storage.
// All operations are scoped to the authenticated userID.
type userFS struct {
	db        *pgxpool.Pool
	filesRoot string
	userID    string
}

func (fs *userFS) Mkdir(ctx context.Context, name string, _ os.FileMode) error {
	name = cleanPath(name)
	if name == "/" {
		return os.ErrExist
	}
	parentPath := path.Dir(name)
	base := path.Base(name)

	parentID, err := fs.resolveToID(ctx, parentPath)
	if err != nil {
		return os.ErrNotExist
	}

	id := uuid.New().String()
	_, err = fs.db.Exec(ctx, `
		INSERT INTO files (id, owner_id, parent_id, is_folder, name, mime_type, size_bytes, storage_path)
		VALUES ($1::uuid, $2::uuid, $3::uuid, true, $4, 'inode/directory', 0, '')
	`, id, fs.userID, parentID, base)
	if err != nil {
		return fmt.Errorf("webdav mkdir: %w", err)
	}
	return nil
}

func (fs *userFS) RemoveAll(ctx context.Context, name string) error {
	name = cleanPath(name)
	rec, err := fs.resolve(ctx, name)
	if err != nil {
		return os.ErrNotExist
	}
	// Soft-delete the record (and all descendants via the trigger or recursive CTE).
	_, err = fs.db.Exec(ctx, `
		WITH RECURSIVE tree AS (
			SELECT id FROM files WHERE id = $1::uuid
			UNION ALL
			SELECT f.id FROM files f JOIN tree t ON f.parent_id = t.id
		)
		UPDATE files SET deleted_at = now() WHERE id IN (SELECT id FROM tree) AND deleted_at IS NULL
	`, rec.id)
	if err != nil {
		return fmt.Errorf("webdav remove: %w", err)
	}
	// Best-effort storage delete for files (not folders — no storage).
	if !rec.isFolder && rec.storagePath != "" {
		_ = os.Remove(rec.storagePath)
	}
	return nil
}

func (fs *userFS) Rename(ctx context.Context, oldName, newName string) error {
	oldName = cleanPath(oldName)
	newName = cleanPath(newName)

	rec, err := fs.resolve(ctx, oldName)
	if err != nil {
		return os.ErrNotExist
	}

	newParentPath := path.Dir(newName)
	newBase := path.Base(newName)

	newParentID, err := fs.resolveToID(ctx, newParentPath)
	if err != nil {
		return os.ErrNotExist
	}

	_, err = fs.db.Exec(ctx, `
		UPDATE files SET name = $1, parent_id = $2::uuid
		WHERE id = $3::uuid AND deleted_at IS NULL
	`, newBase, newParentID, rec.id)
	if err != nil {
		return fmt.Errorf("webdav rename: %w", err)
	}
	return nil
}

func (fs *userFS) Stat(ctx context.Context, name string) (os.FileInfo, error) {
	name = cleanPath(name)
	rec, err := fs.resolve(ctx, name)
	if err != nil {
		return nil, os.ErrNotExist
	}
	return rec.info(), nil
}

func (fs *userFS) OpenFile(ctx context.Context, name string, flag int, _ os.FileMode) (gowebdav.File, error) {
	name = cleanPath(name)

	// Write path: O_CREATE or O_WRONLY or O_TRUNC
	isWrite := flag&(os.O_WRONLY|os.O_RDWR|os.O_CREATE|os.O_TRUNC) != 0
	if isWrite {
		return fs.openForWrite(ctx, name)
	}

	// Read path
	rec, err := fs.resolve(ctx, name)
	if err != nil {
		return nil, os.ErrNotExist
	}

	if rec.isFolder {
		children, err := fs.listDir(ctx, rec.id)
		if err != nil {
			return nil, err
		}
		return &davDir{fi: rec.info(), children: children}, nil
	}

	f, err := os.Open(rec.storagePath)
	if err != nil {
		return nil, os.ErrNotExist
	}
	return &davFile{fi: rec.info(), f: f}, nil
}

// openForWrite handles PUT: buffer to a temp file, commit on Close().
func (fs *userFS) openForWrite(ctx context.Context, name string) (gowebdav.File, error) {
	parentPath := path.Dir(name)
	base := path.Base(name)

	parentID, err := fs.resolveToID(ctx, parentPath)
	if err != nil {
		return nil, os.ErrNotExist
	}

	// Use filesRoot for the temp buffer so it lands on the same volume as the
	// final storage path. Writing to /tmp (default) would fail for large files
	// when the container's tmpfs is small, and would also force a cross-device
	// copy instead of a fast same-volume rename.
	if err := os.MkdirAll(fs.filesRoot, 0750); err != nil {
		return nil, fmt.Errorf("webdav write: mkdir: %w", err)
	}
	tmp, err := os.CreateTemp(fs.filesRoot, ".dav-upload-*")
	if err != nil {
		return nil, fmt.Errorf("webdav write: temp: %w", err)
	}

	// Check if the file already exists (overwrite vs create).
	var existingID, existingStoragePath string
	_ = fs.db.QueryRow(ctx, `
		SELECT id::text, COALESCE(storage_path, '')
		FROM files
		WHERE parent_id = $1::uuid AND name = $2 AND is_folder = false AND deleted_at IS NULL
	`, parentID, base).Scan(&existingID, &existingStoragePath)

	commit := func(tmp *os.File) error {
		defer func() { _ = os.Remove(tmp.Name()) }()

		if _, err := tmp.Seek(0, io.SeekStart); err != nil {
			return err
		}

		fileID := existingID
		if fileID == "" {
			fileID = uuid.New().String()
		}

		storagePath := storagePathFor(fs.filesRoot, fileID)
		if err := os.MkdirAll(filepath.Dir(storagePath), 0750); err != nil {
			return err
		}

		dst, err := os.OpenFile(storagePath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0640)
		if err != nil {
			return err
		}
		hash := sha256.New()
		n, err := io.Copy(io.MultiWriter(dst, hash), tmp)
		dst.Close()
		if err != nil {
			_ = os.Remove(storagePath)
			return err
		}
		shaHex := hex.EncodeToString(hash.Sum(nil))

		if existingID != "" {
			// Overwrite existing file record.
			_, err = fs.db.Exec(ctx, `
				UPDATE files
				SET size_bytes = $1, storage_path = $2, checksum_sha256 = $3, updated_at = now()
				WHERE id = $4::uuid AND deleted_at IS NULL
			`, n, storagePath, shaHex, existingID)
		} else {
			_, err = fs.db.Exec(ctx, `
				INSERT INTO files (id, owner_id, parent_id, is_folder, name, mime_type, size_bytes, storage_path, checksum_sha256)
				VALUES ($1::uuid, $2::uuid, $3::uuid, false, $4, 'application/octet-stream', $5, $6, $7)
			`, fileID, fs.userID, parentID, base, n, storagePath, shaHex)
		}
		if err != nil {
			_ = os.Remove(storagePath)
			// Remove old storage only if overwrite wrote to a new path.
			return fmt.Errorf("webdav write: db: %w", err)
		}
		return nil
	}

	return &davWriteFile{
		tmp:    tmp,
		commit: commit,
		fi:     &davFileInfo{name: base, modTime: time.Now()},
	}, nil
}

// ── Path resolution ───────────────────────────────────────────────────────────

type dbRec struct {
	id          string
	name        string
	isFolder    bool
	size        int64
	modTime     time.Time
	storagePath string
}

func (r *dbRec) info() os.FileInfo {
	return &davFileInfo{name: r.name, size: r.size, isDir: r.isFolder, modTime: r.modTime}
}

func (fs *userFS) resolve(ctx context.Context, name string) (*dbRec, error) {
	name = cleanPath(name)
	if name == "/" {
		// Synthetic root — present as a directory with the user's name.
		return &dbRec{id: "", name: "", isFolder: true, modTime: time.Now()}, nil
	}
	parts := strings.Split(strings.TrimPrefix(name, "/"), "/")
	var currentParentID *string // nil = root
	var last *dbRec
	for i, part := range parts {
		var q string
		var args []any
		if currentParentID == nil {
			q = `
				SELECT id::text, name, is_folder,
				       COALESCE(size_bytes, 0), updated_at,
				       COALESCE(storage_path, '')
				FROM files
				WHERE parent_id IS NULL AND name = $1 AND owner_id = $2::uuid
				  AND deleted_at IS NULL
				LIMIT 1`
			args = []any{part, fs.userID}
		} else {
			q = `
				SELECT id::text, name, is_folder,
				       COALESCE(size_bytes, 0), updated_at,
				       COALESCE(storage_path, '')
				FROM files
				WHERE parent_id = $1::uuid AND name = $2
				  AND deleted_at IS NULL
				  AND (owner_id = $3::uuid OR EXISTS (
				    SELECT 1 FROM files p WHERE p.id = $1::uuid AND p.owner_id = $3::uuid
				  ))
				LIMIT 1`
			args = []any{*currentParentID, part, fs.userID}
		}
		var r dbRec
		err := fs.db.QueryRow(ctx, q, args...).Scan(
			&r.id, &r.name, &r.isFolder, &r.size, &r.modTime, &r.storagePath,
		)
		if err != nil {
			return nil, os.ErrNotExist
		}
		last = &r
		if i < len(parts)-1 {
			if !r.isFolder {
				return nil, os.ErrNotExist
			}
			currentParentID = &r.id
		}
	}
	return last, nil
}

// resolveToID returns the DB id for a path, or a sentinel for root.
func (fs *userFS) resolveToID(ctx context.Context, name string) (string, error) {
	name = cleanPath(name)
	if name == "/" {
		return "", nil // sentinel: root (parent_id IS NULL)
	}
	rec, err := fs.resolve(ctx, name)
	if err != nil {
		return "", err
	}
	return rec.id, nil
}

func (fs *userFS) listDir(ctx context.Context, folderID string) ([]*dbRec, error) {
	var q string
	var args []any
	if folderID == "" {
		// Root
		q = `
			SELECT id::text, name, is_folder,
			       COALESCE(size_bytes, 0), updated_at,
			       COALESCE(storage_path, '')
			FROM files
			WHERE parent_id IS NULL AND owner_id = $1::uuid AND deleted_at IS NULL
			ORDER BY is_folder DESC, name ASC`
		args = []any{fs.userID}
	} else {
		q = `
			SELECT id::text, name, is_folder,
			       COALESCE(size_bytes, 0), updated_at,
			       COALESCE(storage_path, '')
			FROM files
			WHERE parent_id = $1::uuid AND deleted_at IS NULL
			  AND (owner_id = $2::uuid OR EXISTS (
			    SELECT 1 FROM files p WHERE p.id = $1::uuid AND p.owner_id = $2::uuid
			  ))
			ORDER BY is_folder DESC, name ASC`
		args = []any{folderID, fs.userID}
	}
	rows, err := fs.db.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []*dbRec
	for rows.Next() {
		var r dbRec
		if err := rows.Scan(&r.id, &r.name, &r.isFolder, &r.size, &r.modTime, &r.storagePath); err == nil {
			result = append(result, &r)
		}
	}
	return result, rows.Err()
}

// storagePathFor mirrors files.Storage.Path without importing the files package.
func storagePathFor(root, fileID string) string {
	if len(fileID) < 2 {
		return filepath.Join(root, "00", fileID)
	}
	return filepath.Join(root, fileID[:2], fileID)
}

func cleanPath(name string) string {
	return path.Clean("/" + strings.TrimLeft(name, "/"))
}

// ── os.FileInfo ───────────────────────────────────────────────────────────────

type davFileInfo struct {
	name    string
	size    int64
	isDir   bool
	modTime time.Time
}

func (fi *davFileInfo) Name() string       { return fi.name }
func (fi *davFileInfo) Size() int64        { return fi.size }
func (fi *davFileInfo) IsDir() bool        { return fi.isDir }
func (fi *davFileInfo) ModTime() time.Time { return fi.modTime }
func (fi *davFileInfo) Sys() interface{}   { return nil }
func (fi *davFileInfo) Mode() os.FileMode {
	if fi.isDir {
		return os.ModeDir | 0555
	}
	return 0444
}

// ── webdav.File: directory ────────────────────────────────────────────────────

type davDir struct {
	fi       os.FileInfo
	children []*dbRec
	pos      int
}

func (d *davDir) Close() error                               { return nil }
func (d *davDir) Read([]byte) (int, error)                   { return 0, os.ErrInvalid }
func (d *davDir) Seek(int64, int) (int64, error)             { return 0, os.ErrInvalid }
func (d *davDir) Write([]byte) (int, error)                  { return 0, os.ErrPermission }
func (d *davDir) Stat() (os.FileInfo, error)                 { return d.fi, nil }
func (d *davDir) Readdir(count int) ([]os.FileInfo, error) {
	if count <= 0 {
		out := make([]os.FileInfo, len(d.children))
		for i, c := range d.children {
			out[i] = c.info()
		}
		return out, nil
	}
	if d.pos >= len(d.children) {
		return nil, io.EOF
	}
	n := count
	if d.pos+n > len(d.children) {
		n = len(d.children) - d.pos
	}
	out := make([]os.FileInfo, n)
	for i := range out {
		out[i] = d.children[d.pos+i].info()
	}
	d.pos += n
	return out, nil
}

// ── webdav.File: read-only file ───────────────────────────────────────────────

type davFile struct {
	fi os.FileInfo
	f  *os.File
}

func (f *davFile) Close() error                                { return f.f.Close() }
func (f *davFile) Read(p []byte) (int, error)                  { return f.f.Read(p) }
func (f *davFile) Seek(offset int64, whence int) (int64, error) { return f.f.Seek(offset, whence) }
func (f *davFile) Write([]byte) (int, error)                   { return 0, os.ErrPermission }
func (f *davFile) Stat() (os.FileInfo, error)                  { return f.fi, nil }
func (f *davFile) Readdir(int) ([]os.FileInfo, error)          { return nil, os.ErrInvalid }

// ── webdav.File: write-buffered file ─────────────────────────────────────────

type davWriteFile struct {
	tmp    *os.File
	commit func(*os.File) error
	fi     os.FileInfo
}

func (f *davWriteFile) Write(p []byte) (int, error)                  { return f.tmp.Write(p) }
func (f *davWriteFile) Read(p []byte) (int, error)                   { return f.tmp.Read(p) }
func (f *davWriteFile) Seek(offset int64, whence int) (int64, error) { return f.tmp.Seek(offset, whence) }
func (f *davWriteFile) Readdir(int) ([]os.FileInfo, error)           { return nil, os.ErrInvalid }
func (f *davWriteFile) Stat() (os.FileInfo, error)                   { return f.fi, nil }
func (f *davWriteFile) Close() error {
	err := f.commit(f.tmp)
	_ = f.tmp.Close()
	_ = os.Remove(f.tmp.Name())
	if err != nil {
		log.Error().Err(err).Msg("webdav: commit write")
	}
	return err
}
