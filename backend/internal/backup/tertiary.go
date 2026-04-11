package backup

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// TertiaryService writes .shdbak archives to a local mounted path (tertiary
// backup layer — disk, storage box, or mounted share). Subdirectories are
// keyed by user UUID so that multiple users share a single BACKUPS_ROOT.
type TertiaryService struct {
	root    string   // BACKUPS_ROOT — must be writable
	backups *Service // underlying export service
}

// NewTertiaryService creates a TertiaryService.
func NewTertiaryService(root string, backups *Service) *TertiaryService {
	return &TertiaryService{root: root, backups: backups}
}

// TertiaryArchive describes a stored .shdbak archive on disk.
type TertiaryArchive struct {
	Filename  string    `json:"filename"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
}

// userDir returns (and creates) the per-user archive directory.
func (s *TertiaryService) userDir(userID uuid.UUID) (string, error) {
	dir := filepath.Join(s.root, "tertiary", userID.String())
	if err := os.MkdirAll(dir, 0750); err != nil {
		return "", fmt.Errorf("tertiary: mkdir: %w", err)
	}
	return dir, nil
}

// Store exports an encrypted archive for userID into the configured root.
// folderIDs restricts scope; pass nil to export everything.
func (s *TertiaryService) Store(ctx context.Context, userID uuid.UUID, rawToken string, folderIDs []uuid.UUID) (*TertiaryArchive, error) {
	dir, err := s.userDir(userID)
	if err != nil {
		return nil, err
	}

	filename := time.Now().UTC().Format("20060102T150405Z") + ".shdbak"
	path := filepath.Join(dir, filename)

	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0640)
	if err != nil {
		return nil, fmt.Errorf("tertiary: create: %w", err)
	}
	defer f.Close()

	if err := s.backups.Export(ctx, f, userID, rawToken, folderIDs); err != nil {
		os.Remove(path)
		return nil, fmt.Errorf("tertiary: export: %w", err)
	}

	fi, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("tertiary: stat: %w", err)
	}

	log.Info().Str("user_id", userID.String()).Str("file", path).Msg("tertiary: archive stored")
	return &TertiaryArchive{Filename: filename, SizeBytes: fi.Size(), CreatedAt: time.Now().UTC()}, nil
}

// List returns all archives for userID, newest first.
func (s *TertiaryService) List(ctx context.Context, userID uuid.UUID) ([]TertiaryArchive, error) {
	dir, err := s.userDir(userID)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []TertiaryArchive{}, nil
		}
		return nil, fmt.Errorf("tertiary: readdir: %w", err)
	}

	var archives []TertiaryArchive
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".shdbak" {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		archives = append(archives, TertiaryArchive{
			Filename:  e.Name(),
			SizeBytes: fi.Size(),
			CreatedAt: fi.ModTime().UTC(),
		})
	}
	sort.Slice(archives, func(i, j int) bool {
		return archives[i].CreatedAt.After(archives[j].CreatedAt)
	})
	return archives, nil
}

// Download opens the named archive for reading. Caller must close the reader.
func (s *TertiaryService) Download(userID uuid.UUID, filename string) (io.ReadCloser, int64, error) {
	if !isValidArchiveName(filename) {
		return nil, 0, fmt.Errorf("tertiary: invalid filename")
	}
	dir, err := s.userDir(userID)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(filepath.Join(dir, filename))
	if err != nil {
		return nil, 0, fmt.Errorf("tertiary: open: %w", err)
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, fmt.Errorf("tertiary: stat: %w", err)
	}
	return f, fi.Size(), nil
}

// Delete removes the named archive.
func (s *TertiaryService) Delete(userID uuid.UUID, filename string) error {
	if !isValidArchiveName(filename) {
		return fmt.Errorf("tertiary: invalid filename")
	}
	dir, err := s.userDir(userID)
	if err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(dir, filename)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("tertiary: delete: %w", err)
	}
	return nil
}

// isValidArchiveName guards against path traversal; only bare .shdbak filenames
// with no directory separators or ".." components are accepted.
func isValidArchiveName(name string) bool {
	return filepath.Ext(name) == ".shdbak" &&
		!strings.ContainsAny(name, "/\\") &&
		!strings.Contains(name, "..")
}
