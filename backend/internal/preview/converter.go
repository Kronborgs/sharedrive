package preview

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// maxConcurrentConversions caps simultaneous LibreOffice processes to prevent
// a flood of large Office documents from exhausting server memory.
// LibreOffice typically allocates 200–500 MB per instance.
const maxConcurrentConversions = 2

// conversionTimeout limits how long a single LibreOffice invocation may run.
// A hung LibreOffice process will be killed after this duration.
const conversionTimeout = 3 * time.Minute

// Converter wraps a LibreOffice headless process to convert Office documents
// to PDF for in-browser preview. Converted PDFs are cached on disk and
// revalidated against the source file's updated_at timestamp.
type Converter struct {
	cacheDir string
	locks    sync.Map     // per-fileID *sync.Mutex — prevents duplicate conversions
	sem      chan struct{} // global concurrency limit for LibreOffice processes
}

// New creates a Converter that stores cached PDFs in cacheDir.
// The directory is created if it does not exist.
func New(cacheDir string) (*Converter, error) {
	if err := os.MkdirAll(cacheDir, 0750); err != nil {
		return nil, fmt.Errorf("preview.Converter: mkdir %s: %w", cacheDir, err)
	}
	return &Converter{
		cacheDir: cacheDir,
		sem:      make(chan struct{}, maxConcurrentConversions),
	}, nil
}

// PDFPath returns the path to the cached PDF for fileID, converting the
// source file via LibreOffice if the cache is missing or stale.
// updatedAt is the file's last-modified timestamp used for staleness checks.
func (c *Converter) PDFPath(ctx context.Context, fileID, sourcePath string, updatedAt time.Time) (string, error) {
	// Serialize per-fileID to prevent redundant concurrent conversions of the
	// same source file. Different files proceed in parallel (up to the semaphore).
	lock, _ := c.locks.LoadOrStore(fileID, &sync.Mutex{})
	lock.(*sync.Mutex).Lock()
	defer lock.(*sync.Mutex).Unlock()

	dest := filepath.Join(c.cacheDir, fileID+".pdf")

	// Cache hit — only re-convert if the source file is newer than the cached PDF.
	if info, err := os.Stat(dest); err == nil {
		if !info.ModTime().Before(updatedAt) {
			return dest, nil
		}
		_ = os.Remove(dest)
	}

	// Acquire semaphore slot — blocks until a conversion slot is free or ctx is
	// cancelled (e.g. client disconnected before LibreOffice even started).
	select {
	case c.sem <- struct{}{}:
		defer func() { <-c.sem }()
	case <-ctx.Done():
		return "", fmt.Errorf("preview.Converter: context cancelled waiting for slot: %w", ctx.Err())
	}

	// Each invocation gets its own temporary user-profile directory. Sharing the
	// default profile (~/.config/libreoffice) between concurrent processes causes
	// file-lock conflicts and corrupted conversions.
	profileDir, err := os.MkdirTemp("", "lo-profile-")
	if err != nil {
		return "", fmt.Errorf("preview.Converter: create profile dir: %w", err)
	}
	defer os.RemoveAll(profileDir)

	// Wrap in a hard conversion timeout so a hanging LibreOffice process cannot
	// tie up a goroutine indefinitely. This timeout is independent of the outer
	// HTTP request context (which has WriteTimeout disabled for large files).
	convCtx, convCancel := context.WithTimeout(ctx, conversionTimeout)
	defer convCancel()

	profileURL := fmt.Sprintf("file://%s", filepath.ToSlash(profileDir))

	cmd := exec.CommandContext(convCtx,
		"libreoffice",
		"--headless",
		"--norestore",
		"-env:UserInstallation="+profileURL,
		"--convert-to", "pdf",
		"--outdir", c.cacheDir,
		sourcePath,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("preview.Converter: libreoffice: %w — %s", err, out)
	}

	// LibreOffice names the output after the source basename, e.g.
	// "abc123.docx" → "abc123.pdf". Rename it to fileID.pdf.
	base := filepath.Base(sourcePath)
	ext := filepath.Ext(base)
	libreOut := filepath.Join(c.cacheDir, base[:len(base)-len(ext)]+".pdf")
	if libreOut != dest {
		if err := os.Rename(libreOut, dest); err != nil {
			// libreOut may not exist if LibreOffice used a different naming;
			// check dest directly before failing.
			if _, serr := os.Stat(dest); serr != nil {
				return "", fmt.Errorf("preview.Converter: rename output: %w", err)
			}
		}
	}

	return dest, nil
}
