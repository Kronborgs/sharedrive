package files

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// File represents a row in the files table.
type File struct {
	ID           uuid.UUID  `json:"id"`
	ParentID     *uuid.UUID `json:"parent_id,omitempty"`
	OwnerID      uuid.UUID  `json:"owner_id"`
	IsFolder     bool       `json:"is_folder"`
	Name         string     `json:"name"`
	MimeType     string     `json:"mime_type,omitempty"`
	SizeBytes    int64      `json:"size_bytes"`
	StoragePath  string     `json:"-"`
	DeletedAt    *time.Time `json:"deleted_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
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

const fileCols = `id, parent_id, owner_id, is_folder, name, mime_type,
                  size_bytes, storage_path, deleted_at, created_at, updated_at`

func scanFile(row interface {
	Scan(dest ...any) error
}) (*File, error) {
	f := &File{}
	return f, row.Scan(
		&f.ID, &f.ParentID, &f.OwnerID, &f.IsFolder, &f.Name, &f.MimeType,
		&f.SizeBytes, &f.StoragePath, &f.DeletedAt, &f.CreatedAt, &f.UpdatedAt,
	)
}

// List returns direct children of parentID for ownerID (nil parentID = root).
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
		rows, err = s.db.Query(ctx,
			`SELECT `+fileCols+` FROM files
			 WHERE owner_id = $1 AND parent_id = $2 AND deleted_at IS NULL
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

// CreateFolder inserts a new folder record.
func (s *Service) CreateFolder(ctx context.Context, ownerID, name string, parentID *uuid.UUID) (*File, error) {
	f := &File{}
	err := s.db.QueryRow(ctx,
		`INSERT INTO files (owner_id, parent_id, is_folder, name)
		 VALUES ($1, $2, true, $3)
		 RETURNING `+fileCols,
		ownerID, parentID, name,
	).Scan(
		&f.ID, &f.ParentID, &f.OwnerID, &f.IsFolder, &f.Name, &f.MimeType,
		&f.SizeBytes, &f.StoragePath, &f.DeletedAt, &f.CreatedAt, &f.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("files.CreateFolder: %w", err)
	}
	return f, nil
}

// Rename changes the name of a file/folder owned by ownerID.
func (s *Service) Rename(ctx context.Context, id, ownerID, newName string) error {
	result, err := s.db.Exec(ctx,
		`UPDATE files SET name = $1, updated_at = now()
		 WHERE id = $2 AND owner_id = $3 AND deleted_at IS NULL`,
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
	_, err := s.db.Exec(ctx,
		`UPDATE files SET parent_id = $1, updated_at = now()
		 WHERE id = $2 AND owner_id = $3 AND deleted_at IS NULL`,
		newParentID, id, ownerID,
	)
	return err
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

// Breadcrumbs returns the ancestor chain from root to parentID.
func (s *Service) Breadcrumbs(ctx context.Context, fileID, ownerID string) ([]*File, error) {
	// Walk up via recursive CTE.
	rows, err := s.db.Query(ctx,
		`WITH RECURSIVE ancestors AS (
		   SELECT `+fileCols+` FROM files WHERE id = $1 AND owner_id = $2
		   UNION ALL
		   SELECT f.id, f.parent_id, f.owner_id, f.is_folder, f.name, f.mime_type,
		          f.size_bytes, f.storage_path, f.deleted_at, f.created_at, f.updated_at
		   FROM files f
		   JOIN ancestors a ON f.id = a.parent_id
		   WHERE f.owner_id = $2
		 )
		 SELECT * FROM ancestors ORDER BY created_at ASC`,
		fileID, ownerID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var chain []*File
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, err
		}
		chain = append(chain, f)
	}
	return chain, rows.Err()
}
