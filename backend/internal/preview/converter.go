package preview

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// maxConcurrentConversions caps simultaneous Gotenberg requests to prevent
// saturating the Gotenberg service with parallel large document conversions.
const maxConcurrentConversions = 4

// conversionTimeout limits how long a single Gotenberg HTTP call may run.
const conversionTimeout = 3 * time.Minute

// Converter sends Office documents to a Gotenberg instance for PDF conversion.
// Converted PDFs are cached on disk and revalidated against the source file's
// updated_at timestamp.
type Converter struct {
	cacheDir    string
	gotenbergURL string
	client      *http.Client
	locks       sync.Map     // per-fileID *sync.Mutex — prevents duplicate conversions
	sem         chan struct{} // global concurrency limit
}

// New creates a Converter that stores cached PDFs in cacheDir and sends
// conversion requests to gotenbergURL (e.g. "http://gotenberg:3000").
func New(cacheDir, gotenbergURL string) (*Converter, error) {
	if err := os.MkdirAll(cacheDir, 0750); err != nil {
		return nil, fmt.Errorf("preview.Converter: mkdir %s: %w", cacheDir, err)
	}
	return &Converter{
		cacheDir:     cacheDir,
		gotenbergURL: gotenbergURL,
		client:       &http.Client{},
		sem:          make(chan struct{}, maxConcurrentConversions),
	}, nil
}

// PDFPath returns the path to the cached PDF for fileID, converting the
// source file via Gotenberg if the cache is missing or stale.
// fileName is the original file name (including extension) used so Gotenberg
// can detect the document type. updatedAt is used for staleness checks.
func (c *Converter) PDFPath(ctx context.Context, fileID, sourcePath, fileName string, updatedAt time.Time) (string, error) {
	// Serialize per-fileID to prevent redundant concurrent conversions of the
	// same source file.
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

	// Acquire semaphore slot.
	select {
	case c.sem <- struct{}{}:
		defer func() { <-c.sem }()
	case <-ctx.Done():
		return "", fmt.Errorf("preview.Converter: context cancelled waiting for slot: %w", ctx.Err())
	}

	// Hard conversion timeout, independent of the outer HTTP request context.
	convCtx, convCancel := context.WithTimeout(ctx, conversionTimeout)
	defer convCancel()

	// Build multipart form for Gotenberg's LibreOffice endpoint.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	f, err := os.Open(sourcePath)
	if err != nil {
		return "", fmt.Errorf("preview.Converter: open source: %w", err)
	}
	defer f.Close()

	// Field name must be "files" and the filename must carry the correct extension
	// so Gotenberg can identify the document type. Use the original file name
	// (not the UUID-based storage path) to preserve the extension.
	fw, err := mw.CreateFormFile("files", fileName)
	if err != nil {
		return "", fmt.Errorf("preview.Converter: create form file: %w", err)
	}
	if _, err := io.Copy(fw, f); err != nil {
		return "", fmt.Errorf("preview.Converter: copy source: %w", err)
	}
	mw.Close()

	endpoint := c.gotenbergURL + "/forms/libreoffice/convert"
	req, err := http.NewRequestWithContext(convCtx, http.MethodPost, endpoint, &buf)
	if err != nil {
		return "", fmt.Errorf("preview.Converter: build request: %w", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := c.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("preview.Converter: gotenberg request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("preview.Converter: gotenberg returned %d — %s", resp.StatusCode, body)
	}

	// Write the returned PDF to the cache atomically via a temp file.
	tmp, err := os.CreateTemp(c.cacheDir, "gotenberg-*.pdf")
	if err != nil {
		return "", fmt.Errorf("preview.Converter: create temp: %w", err)
	}
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", fmt.Errorf("preview.Converter: write pdf: %w", err)
	}
	tmp.Close()

	if err := os.Rename(tmp.Name(), dest); err != nil {
		os.Remove(tmp.Name())
		return "", fmt.Errorf("preview.Converter: rename output: %w", err)
	}

	return dest, nil
}
