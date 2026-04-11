package backup

// Writer is a thin, opinionated wrapper around yeka/zip that writes
// AES-256-encrypted entries to an underlying io.Writer.
//
// It has no dependencies on Sharedrive internals and can be used in any
// Go application that needs to produce password-protected ZIP archives.
//
// Usage:
//
//	zw := backup.NewWriter(w, password)
//	defer zw.Close()
//	_ = zw.AddJSON("manifest.json", manifest)
//	_ = zw.AddBlob("files/abc123", reader)

import (
	"encoding/json"
	"fmt"
	"io"

	yzip "github.com/yeka/zip"
)

// Writer wraps a yeka/zip writer and applies a single AES-256 password to
// every entry. Call Close to flush the ZIP central directory.
type Writer struct {
	zw  *yzip.Writer
	pwd string
}

// NewWriter creates a Writer that encrypts all entries with password.
func NewWriter(w io.Writer, password string) *Writer {
	return &Writer{zw: yzip.NewWriter(w), pwd: password}
}

// AddJSON encodes v as indented JSON and writes it as an encrypted ZIP entry.
func (w *Writer) AddJSON(name string, v any) error {
	fw, err := w.zw.Encrypt(name, w.pwd, yzip.AES256Encryption)
	if err != nil {
		return fmt.Errorf("zip: create entry %q: %w", name, err)
	}
	enc := json.NewEncoder(fw)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return fmt.Errorf("zip: encode %q: %w", name, err)
	}
	return w.zw.Flush()
}

// AddBlob copies r into an encrypted ZIP entry named name.
func (w *Writer) AddBlob(name string, r io.Reader) error {
	fw, err := w.zw.Encrypt(name, w.pwd, yzip.AES256Encryption)
	if err != nil {
		return fmt.Errorf("zip: create entry %q: %w", name, err)
	}
	if _, err := io.Copy(fw, r); err != nil {
		return fmt.Errorf("zip: copy %q: %w", name, err)
	}
	return w.zw.Flush()
}

// Close writes the ZIP central directory. Must be called exactly once.
func (w *Writer) Close() error {
	return w.zw.Close()
}
