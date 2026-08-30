package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/yourname/privatedrive/internal/config"
	"github.com/yourname/privatedrive/internal/db"
	"github.com/yourname/privatedrive/internal/files"
)

type manifestItem struct {
	CommonsFilename string `json:"commons_filename"`
	CommonsPage     string `json:"commons_page"`
	Category        string `json:"category"`
	TitleDA         string `json:"title_da"`
	TitleEN         string `json:"title_en"`
	ExpectedLicense string `json:"expected_license"`
}

func loadManifest(path string) ([]manifestItem, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var items []manifestItem
	if err := json.Unmarshal(data, &items); err != nil {
		return nil, err
	}
	return items, nil
}

func main() {
	manifestPath := flag.String("manifest", "internal/rooms/gif_starter_manifest.json", "reviewed Commons GIF manifest")
	apply := flag.Bool("apply", false, "download and import validated GIFs")
	flag.Parse()
	items, err := loadManifest(*manifestPath)
	if err != nil {
		panic(err)
	}
	if !*apply {
		fmt.Printf("Validated manifest with %d entries. Use --apply to import.\n", len(items))
		return
	}
	if err := runApply(context.Background(), items); err != nil {
		panic(err)
	}
	fmt.Printf("Imported validated GIF library entries from %s.\n", *manifestPath)
}

func acceptedLicense(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	return strings.HasPrefix(value, "cc0") || strings.HasPrefix(value, "public domain") || strings.HasPrefix(value, "cc by")
}

func commonsLookupURL(filename string) string {
	return "https://commons.wikimedia.org/w/api.php?action=query&titles=" + url.QueryEscape("File:"+filename) + "&prop=imageinfo&iiprop=mime|size|url|extmetadata&format=json"
}

func newCommonsRequest(filename string) (*http.Request, error) {
	request, err := http.NewRequest(http.MethodGet, commonsLookupURL(filename), nil)
	if err == nil {
		request.Header.Set("User-Agent", "SharedriveRoomsGIFSeed/1.0")
	}
	return request, err
}

const maxGIFBytes = 5 * 1024 * 1024

func validateGIF(data []byte) (string, error) {
	if len(data) < 6 || len(data) > maxGIFBytes || (string(data[:6]) != "GIF87a" && string(data[:6]) != "GIF89a") {
		return "", fmt.Errorf("download is not a valid GIF within the seed limit")
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func readGIF(response *http.Response) ([]byte, string, error) {
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxGIFBytes+1))
	if err != nil {
		return nil, "", err
	}
	checksum, err := validateGIF(data)
	return data, checksum, err
}

func libraryContains(ctx context.Context, pool *pgxpool.Pool, commonsFilename string) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM room_gif_library WHERE commons_filename = $1)`, commonsFilename).Scan(&exists)
	return exists, err
}

func existingFileByChecksum(ctx context.Context, pool *pgxpool.Pool, checksum string) (string, bool, error) {
	var fileID string
	err := pool.QueryRow(ctx, `SELECT id::text FROM files WHERE checksum_sha256 = $1 AND deleted_at IS NULL LIMIT 1`, checksum).Scan(&fileID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	return fileID, true, nil
}

func firstActiveAdmin(ctx context.Context, pool *pgxpool.Pool) (string, error) {
	var ownerID string
	err := pool.QueryRow(ctx, `SELECT id::text FROM users WHERE role = 'admin' AND is_active ORDER BY created_at, id LIMIT 1`).Scan(&ownerID)
	return ownerID, err
}

func addLibraryItem(ctx context.Context, pool *pgxpool.Pool, fileID, ownerID string, item manifestItem) error {
	_, err := pool.Exec(ctx, `INSERT INTO room_gif_library(file_id, title, search_terms, category, created_by, commons_filename, commons_page) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, fileID, item.TitleEN, item.TitleDA+" "+item.TitleEN, item.Category, ownerID, item.CommonsFilename, item.CommonsPage)
	return err
}

func runApply(ctx context.Context, items []manifestItem) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	pool, err := db.New(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()
	ownerID, err := firstActiveAdmin(ctx, pool)
	if err != nil {
		return err
	}
	_ = ownerID
	fileService := files.NewService(pool, files.NewStorage(cfg.FilesRoot, cfg.FileEncryptKey))
	client := &http.Client{Timeout: 45 * time.Second}
	for index, item := range items {
		if item.CommonsFilename == "" || item.CommonsPage == "" || item.Category == "" || !acceptedLicense(item.ExpectedLicense) {
			return fmt.Errorf("invalid manifest entry %d", index+1)
		}
		exists, err := libraryContains(ctx, pool, item.CommonsFilename)
		if err != nil || exists {
			continue
		}
		request, err := newCommonsRequest(item.CommonsFilename)
		if err != nil {
			return err
		}
		response, err := client.Do(request)
		if err != nil {
			return err
		}
		mimeType, size, sourceURL, license, err := parseCommonsResponse(response)
		if err != nil {
			return err
		}
		if mimeType != "image/gif" || size < 1 || size > maxGIFBytes || !acceptedLicense(license) {
			return fmt.Errorf("Commons metadata rejected %s", item.CommonsFilename)
		}
		downloadRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, sourceURL, nil)
		if err != nil {
			return err
		}
		downloadRequest.Header.Set("User-Agent", "SharedriveRoomsGIFSeed/1.0")
		downloadResponse, err := client.Do(downloadRequest)
		if err != nil {
			return err
		}
		blob, checksum, err := readGIF(downloadResponse)
		if err != nil {
			return err
		}
		fileID, found, err := existingFileByChecksum(ctx, pool, checksum)
		if err != nil {
			return err
		}
		if !found {
			created, err := fileService.Upload(ctx, files.UploadParams{OwnerID: ownerID, Name: item.CommonsFilename, MimeType: "image/gif", ContentLength: int64(len(blob))}, bytes.NewReader(blob))
			if err != nil {
				return err
			}
			fileID = created.ID.String()
		}
		if err := addLibraryItem(ctx, pool, fileID, ownerID, item); err != nil {
			return err
		}
	}
	return nil
}

type commonsAPIResponse struct {
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

func parseCommonsResponse(response *http.Response) (string, int64, string, string, error) {
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", 0, "", "", fmt.Errorf("Commons returned %s", response.Status)
	}
	var payload commonsAPIResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return "", 0, "", "", err
	}
	for _, page := range payload.Query.Pages {
		if len(page.ImageInfo) == 1 {
			info := page.ImageInfo[0]
			return info.Mime, info.Size, info.URL, info.ExtMetadata["LicenseShortName"].Value, nil
		}
	}
	return "", 0, "", "", errors.New("Commons file was not found")
}
