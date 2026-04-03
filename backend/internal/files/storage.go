package files

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Storage manages raw file bytes on disk using UUID-sharded paths.
// Path structure: {root}/{first-2-chars-of-uuid}/{full-uuid}
type Storage struct {
	root string
}

// NewStorage creates a Storage. root must exist and be writable.
func NewStorage(root string) *Storage {
	return &Storage{root: root}
}

// Path returns the absolute storage path for a given UUID.
func (s *Storage) Path(id string) string {
	if len(id) < 2 {
		return filepath.Join(s.root, "00", id)
	}
	return filepath.Join(s.root, id[:2], id)
}

// Write stores r into the sharded path for id, creating parent directories as
// needed. Returns the number of bytes written.
func (s *Storage) Write(id string, r io.Reader) (int64, error) {
	dest := s.Path(id)
	if err := os.MkdirAll(filepath.Dir(dest), 0750); err != nil {
		return 0, fmt.Errorf("storage: mkdir: %w", err)
	}
	f, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0640)
	if err != nil {
		return 0, fmt.Errorf("storage: open: %w", err)
	}
	defer f.Close()
	n, err := io.Copy(f, r)
	if err != nil {
		return n, fmt.Errorf("storage: write: %w", err)
	}
	return n, nil
}

// Open returns a *os.File for reading the stored file.
// Caller is responsible for closing the file.
func (s *Storage) Open(id string) (*os.File, error) {
	return os.Open(s.Path(id))
}

// Delete removes the stored file. Returns nil if the file does not exist.
func (s *Storage) Delete(id string) error {
	if err := os.Remove(s.Path(id)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("storage: delete %s: %w", id, err)
	}
	return nil
}

// Exists reports whether the stored file exists on disk.
func (s *Storage) Exists(id string) bool {
	_, err := os.Stat(s.Path(id))
	return err == nil
}
