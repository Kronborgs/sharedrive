package rooms

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/files"
)

//go:embed gif_starter_manifest.json
var starterGIFManifest []byte

const starterGIFMaxBytes = 5 * 1024 * 1024

type starterGIF struct {
	CommonsFilename string `json:"commons_filename"`
	CommonsPage     string `json:"commons_page"`
	Category        string `json:"category"`
	TitleDA         string `json:"title_da"`
	TitleEN         string `json:"title_en"`
	ExpectedLicense string `json:"expected_license"`
}

type starterCommons struct {
	Query struct {
		Pages map[string]struct {
			ImageInfo []struct {
				Mime        string `json:"mime"`
				Size        int64  `json:"size"`
				URL         string `json:"url"`
				ExtMetadata map[string]struct {
					Value string `json:"value"`
				} `json:"extmetadata"`
			} `json:"imageinfo"`
		} `json:"pages"`
	} `json:"query"`
}

func starterLicenseOK(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	return strings.HasPrefix(value, "cc0") || strings.HasPrefix(value, "public domain") || strings.HasPrefix(value, "cc by")
}

// SeedStarterGIFs imports the missing Common-licensed starter GIFs. It is
// idempotent: a later restart resumes an interrupted import without duplicates.
func (service *Service) SeedStarterGIFs(ctx context.Context) error {
	enabled, err := service.Enabled(ctx)
	if err != nil || !enabled {
		return err
	}

	var items []starterGIF
	if err := json.Unmarshal(starterGIFManifest, &items); err != nil {
		return err
	}

	owner, err := service.starterGIFOwner(ctx)
	if err != nil {
		return err
	}

	client := &http.Client{Timeout: 45 * time.Second}
	result := starterGIFSeedResult{}
	for _, item := range items {
		service.seedStarterGIFItem(ctx, client, owner, item, &result)
		if result.total()%10 == 0 {
			log.Info().Int("imported", result.imported).Int("existing", result.existing).Int("failed", result.failed).Msg("rooms: starter GIF seed progress")
		}
	}
	log.Info().Int("imported", result.imported).Int("existing", result.existing).Int("failed", result.failed).Msg("rooms: starter GIF seed completed")
	if result.imported == 0 && result.existing == 0 && result.failed > 0 {
		return fmt.Errorf("no starter GIFs could be imported")
	}
	return nil
}

type starterGIFSeedResult struct {
	imported int
	existing int
	failed   int
}

func (result starterGIFSeedResult) total() int {
	return result.imported + result.existing + result.failed
}

func (service *Service) starterGIFOwner(ctx context.Context) (string, error) {
	var owner string
	err := service.db.QueryRow(ctx, `SELECT id::text FROM users WHERE role='admin' AND is_active ORDER BY created_at,id LIMIT 1`).Scan(&owner)
	return owner, err
}

func (service *Service) seedStarterGIFItem(ctx context.Context, client *http.Client, owner string, item starterGIF, result *starterGIFSeedResult) {
	exists, err := service.starterGIFExists(ctx, starterGIFMarker(item))
	if err != nil {
		result.failed++
		log.Warn().Err(err).Str("filename", item.CommonsFilename).Msg("rooms: could not check starter GIF")
		return
	}
	if exists {
		result.existing++
		return
	}
	if err := service.seedStarterGIF(ctx, client, owner, item); err != nil {
		result.failed++
		log.Warn().Err(err).Str("filename", item.CommonsFilename).Msg("rooms: starter GIF was skipped")
		return
	}
	result.imported++
	time.Sleep(2 * time.Second)
}

func starterGIFMarker(item starterGIF) string {
	sum := sha256.Sum256([]byte(item.CommonsFilename))
	return "starter-gif:" + hex.EncodeToString(sum[:])
}

func (service *Service) starterGIFExists(ctx context.Context, filename string) (bool, error) {
	var exists bool
	err := service.db.QueryRow(ctx, `SELECT true FROM room_gif_library WHERE search_terms LIKE '%' || $1 || '%'`, filename).Scan(&exists)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return exists, err
}

func (service *Service) seedStarterGIF(ctx context.Context, client *http.Client, owner string, item starterGIF) error {
	endpoint := "https://commons.wikimedia.org/w/api.php?action=query&titles=" + url.QueryEscape("File:"+item.CommonsFilename) + "&prop=imageinfo&iiprop=mime|size|url|extmetadata&format=json"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "SharedriveRoomsGIFSeed/1.0")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("Commons returned %s", res.Status)
	}

	var data starterCommons
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil {
		return err
	}
	for _, page := range data.Query.Pages {
		if len(page.ImageInfo) != 1 {
			continue
		}
		info := page.ImageInfo[0]
		if info.Mime != "image/gif" || info.Size < 1 || info.Size > starterGIFMaxBytes || !starterLicenseOK(info.ExtMetadata["LicenseShortName"].Value) {
			return fmt.Errorf("invalid starter GIF %s", item.CommonsFilename)
		}
		return service.storeStarterGIF(ctx, client, owner, item, info.URL)
	}
	return fmt.Errorf("Commons file missing: %s", item.CommonsFilename)
}

func (service *Service) storeStarterGIF(ctx context.Context, client *http.Client, owner string, item starterGIF, source string) error {
	parsed, err := url.Parse(source)
	if err != nil || !strings.HasSuffix(strings.ToLower(parsed.Host), "wikimedia.org") {
		return fmt.Errorf("invalid Commons host")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "SharedriveRoomsGIFSeed/1.0")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("GIF download returned %s", res.Status)
	}
	blob, err := io.ReadAll(io.LimitReader(res.Body, starterGIFMaxBytes+1))
	if err != nil {
		return err
	}
	if len(blob) < 6 || len(blob) > starterGIFMaxBytes || (string(blob[:6]) != "GIF87a" && string(blob[:6]) != "GIF89a") {
		return fmt.Errorf("invalid GIF binary")
	}

	sum := sha256.Sum256(blob)
	checksum := hex.EncodeToString(sum[:])
	fileID, err := service.fileIDByChecksum(ctx, checksum)
	if errors.Is(err, pgx.ErrNoRows) {
		file, uploadErr := service.fileSvc.Upload(ctx, files.UploadParams{OwnerID: owner, Name: item.CommonsFilename, MimeType: "image/gif", ContentLength: int64(len(blob))}, bytes.NewReader(blob))
		if uploadErr != nil {
			return uploadErr
		}
		fileID = file.ID.String()
	} else if err != nil {
		return err
	}
	_, err = service.db.Exec(ctx, `INSERT INTO room_gif_library(file_id,title,search_terms,category,created_by,commons_filename,commons_page) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, fileID, item.TitleEN, starterGIFMarker(item)+" "+item.TitleDA+" "+item.TitleEN, item.Category, owner)
	return err
}

func (service *Service) fileIDByChecksum(ctx context.Context, checksum string) (string, error) {
	var fileID string
	err := service.db.QueryRow(ctx, `SELECT id::text FROM files WHERE checksum_sha256=$1 AND deleted_at IS NULL LIMIT 1`, checksum).Scan(&fileID)
	return fileID, err
}
