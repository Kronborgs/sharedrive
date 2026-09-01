package rooms

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/yourname/privatedrive/internal/files"
)

var (
	ErrInvalidRemoteGIFURL = errors.New("invalid remote GIF URL")
	ErrInvalidRemoteGIF    = errors.New("remote resource is not a valid GIF")
)

var remoteGIFHosts = map[string]struct{}{
	"media.giphy.com": {},
	"i.giphy.com":     {},
	"giphy.com":       {},
	"www.giphy.com":   {},
	"media.tenor.com": {},
	"c.tenor.com":     {},
	"tenor.com":       {},
	"www.tenor.com":   {},
}

func parseRemoteGIFURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" {
		return nil, ErrInvalidRemoteGIFURL
	}
	if _, allowed := remoteGIFHosts[strings.ToLower(parsed.Hostname())]; !allowed {
		return nil, ErrInvalidRemoteGIFURL
	}
	if !strings.HasSuffix(strings.ToLower(parsed.Path), ".gif") {
		return nil, ErrInvalidRemoteGIFURL
	}
	parsed.Fragment = ""
	return parsed, nil
}

func remoteGIFClient() *http.Client {
	return &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many GIF redirects")
			}
			_, err := parseRemoteGIFURL(request.URL.String())
			return err
		},
	}
}

func downloadRemoteGIF(ctx context.Context, client *http.Client, source *url.URL) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "SharedriveRoomsGIFImport/1.0")
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GIF download returned %s", response.Status)
	}
	if response.ContentLength > starterGIFMaxBytes {
		return nil, ErrInvalidRemoteGIF
	}
	blob, err := io.ReadAll(io.LimitReader(response.Body, starterGIFMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if !validGIFBinary(blob) {
		return nil, ErrInvalidRemoteGIF
	}
	return blob, nil
}

func validGIFBinary(blob []byte) bool {
	if len(blob) < 6 || len(blob) > starterGIFMaxBytes {
		return false
	}
	header := string(blob[:6])
	return header == "GIF87a" || header == "GIF89a"
}

func remoteGIFTitle(source *url.URL) string {
	name := strings.TrimSuffix(path.Base(source.Path), path.Ext(source.Path))
	name = strings.TrimSpace(name)
	if name == "" || strings.EqualFold(name, "giphy") {
		name = source.Hostname()
	}
	if len(name) > 80 {
		name = name[:80]
	}
	return name
}

func (service *Service) existingRemoteGIF(ctx context.Context, sourceURL, checksum string) (GIFLibraryItem, error) {
	var item GIFLibraryItem
	err := service.db.QueryRow(ctx, `SELECT library.id, library.file_id, library.title, library.search_terms,
		library.category, file.name, file.mime_type
		FROM room_gif_library library
		JOIN files file ON file.id = library.file_id
		WHERE file.deleted_at IS NULL
		  AND (library.source_url = $1 OR file.checksum_sha256 = $2)
		ORDER BY (library.source_url = $1) DESC
		LIMIT 1`, sourceURL, checksum).Scan(
		&item.ID, &item.FileID, &item.Title, &item.SearchTerms,
		&item.Category, &item.Name, &item.MimeType,
	)
	return item, err
}

// ImportRemoteGIF downloads an allow-listed direct Giphy/Tenor GIF once and
// stores it in the global local library. Later imports reuse the stored blob.
func (service *Service) ImportRemoteGIF(ctx context.Context, actorID uuid.UUID, rawURL string) (GIFLibraryItem, error) {
	source, err := parseRemoteGIFURL(rawURL)
	if err != nil {
		return GIFLibraryItem{}, err
	}
	blob, err := downloadRemoteGIF(ctx, remoteGIFClient(), source)
	if err != nil {
		return GIFLibraryItem{}, err
	}
	sum := sha256.Sum256(blob)
	checksum := hex.EncodeToString(sum[:])
	if item, findErr := service.existingRemoteGIF(ctx, source.String(), checksum); findErr == nil {
		return item, nil
	} else if !errors.Is(findErr, pgx.ErrNoRows) {
		return GIFLibraryItem{}, findErr
	}

	title := remoteGIFTitle(source)
	fileName := "chat-gif-" + checksum[:16] + ".gif"
	file, err := service.fileSvc.Upload(ctx, files.UploadParams{
		OwnerID:       actorID.String(),
		Name:          fileName,
		MimeType:      "image/gif",
		ContentLength: int64(len(blob)),
	}, bytes.NewReader(blob))
	if err != nil {
		return GIFLibraryItem{}, err
	}

	var item GIFLibraryItem
	err = service.db.QueryRow(ctx, `INSERT INTO room_gif_library
		(file_id, title, search_terms, category, created_by, source_url)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, file_id, title, search_terms, category`,
		file.ID, title, "imported gif "+source.Hostname()+" "+title, "Imported", actorID, source.String(),
	).Scan(&item.ID, &item.FileID, &item.Title, &item.SearchTerms, &item.Category)
	if err != nil {
		return GIFLibraryItem{}, err
	}
	item.Name, item.MimeType = file.Name, file.MimeType
	return item, nil
}
