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

const maxGIFBytes = 5 * 1024 * 1024

type manifestItem struct {
	CommonsFilename string `json:"commons_filename"`
	CommonsPage     string `json:"commons_page"`
	Category        string `json:"category"`
	TitleDA         string `json:"title_da"`
	TitleEN         string `json:"title_en"`
	ExpectedLicense string `json:"expected_license"`
}

type commonsResponse struct {
	Query struct {
		Pages map[string]struct {
			Missing   bool `json:"missing"`
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
type commonsInfo struct {
	MIME        string
	Size        int64
	URL         string
	License     string
	LicenseURL  string
	Author      string
	Attribution string
}

func acceptedLicense(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	return strings.HasPrefix(value, "cc0") || strings.HasPrefix(value, "public domain") || strings.HasPrefix(value, "cc by")
}

func commonsFile(ctx context.Context, client *http.Client, filename string) (commonsInfo, error) {
	endpoint := "https://commons.wikimedia.org/w/api.php?action=query&titles=" + url.QueryEscape("File:"+filename) + "&prop=imageinfo&iiprop=mime|size|url|extmetadata&format=json"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return commonsInfo{}, err
	}
	request.Header.Set("User-Agent", "SharedriveRoomsGIFSeed/1.0")
	response, err := client.Do(request)
	if err != nil {
		return commonsInfo{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return commonsInfo{}, fmt.Errorf("Commons returned %s", response.Status)
	}
	var payload commonsResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return commonsInfo{}, err
	}
	for _, page := range payload.Query.Pages {
		if page.Missing || len(page.ImageInfo) != 1 {
			continue
		}
		info := page.ImageInfo[0]
		metadata := func(key string) string { return info.ExtMetadata[key].Value }
		return commonsInfo{MIME: info.Mime, Size: info.Size, URL: info.URL, License: metadata("LicenseShortName"), LicenseURL: metadata("LicenseUrl"), Author: metadata("Artist"), Attribution: metadata("Attribution")}, nil
	}
	return commonsInfo{}, errors.New("Commons file was not found")
}

func downloadGIF(ctx context.Context, client *http.Client, source string, expectedSize int64) ([]byte, string, error) {
	parsed, err := url.Parse(source)
	if err != nil || parsed.Host == "" || !strings.HasSuffix(strings.ToLower(parsed.Host), "wikimedia.org") {
		return nil, "", errors.New("Commons returned an invalid download host")
	}
	if expectedSize < 1 || expectedSize > maxGIFBytes {
		return nil, "", errors.New("GIF size is outside the seed limit")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return nil, "", err
	}
	request.Header.Set("User-Agent", "SharedriveRoomsGIFSeed/1.0")
	response, err := client.Do(request)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("download returned %s", response.Status)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxGIFBytes+1))
	if err != nil {
		return nil, "", err
	}
	if len(data) < 6 || len(data) > maxGIFBytes || (string(data[:6]) != "GIF87a" && string(data[:6]) != "GIF89a") {
		return nil, "", errors.New("download is not a valid GIF within the seed limit")
	}
	sum := sha256.Sum256(data)
	return data, hex.EncodeToString(sum[:]), nil
}

func main() {
	manifestPath := flag.String("manifest", "internal/rooms/gif_starter_manifest.json", "reviewed Commons GIF manifest")
	apply := flag.Bool("apply", false, "download and import after all validation")
	flag.Parse()
	data, err := os.ReadFile(*manifestPath)
	if err != nil {
		panic(err)
	}
	var items []manifestItem
	if err := json.Unmarshal(data, &items); err != nil {
		panic(err)
	}
	if len(items) == 0 {
		panic("manifest contains no entries")
	}
	cfg, err := config.Load()
	if err != nil {
		panic(err)
	}
	ctx := context.Background()
	pool, err := db.New(ctx, cfg)
	if err != nil {
		panic(err)
	}
	defer pool.Close()
	var ownerID string
	if err := pool.QueryRow(ctx, `SELECT id::text FROM users WHERE role = 'admin' AND is_active ORDER BY created_at, id LIMIT 1`).Scan(&ownerID); err != nil {
		panic("no active admin account is available for GIF ownership")
	}
	fileService := files.NewService(pool, files.NewStorage(cfg.FilesRoot, cfg.FileEncryptKey))
	client := &http.Client{Timeout: 45 * time.Second}
	for index, item := range items {
		if item.CommonsFilename == "" || item.CommonsPage == "" || item.Category == "" || !acceptedLicense(item.ExpectedLicense) {
			panic(fmt.Sprintf("invalid manifest entry %d", index+1))
		}
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM room_gif_library WHERE commons_filename=$1)`, item.CommonsFilename).Scan(&exists); err != nil {
			panic(err)
		}
		if exists {
			continue
		}
		verifyCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		info, err := commonsFile(verifyCtx, client, item.CommonsFilename)
		cancel()
		if err != nil {
			panic(fmt.Errorf("%s: %w", item.CommonsFilename, err))
		}
		if info.MIME != "image/gif" || info.Size > maxGIFBytes || !acceptedLicense(info.License) {
			panic(fmt.Sprintf("%s no longer meets MIME, size or license requirements", item.CommonsFilename))
		}
		if !*apply {
			fmt.Printf("validated %s\n", item.CommonsFilename)
			time.Sleep(2 * time.Second)
			continue
		}
		blob, checksum, err := downloadGIF(ctx, client, info.URL, info.Size)
		if err != nil {
			panic(fmt.Errorf("%s: %w", item.CommonsFilename, err))
		}
		var existingFileID string
		err = pool.QueryRow(ctx, `SELECT id::text FROM files WHERE checksum_sha256=$1 AND deleted_at IS NULL LIMIT 1`, checksum).Scan(&existingFileID)
		if err == nil {
			_, err = pool.Exec(ctx, `INSERT INTO room_gif_library(file_id,title,search_terms,category,created_by,commons_filename,commons_page,commons_source_url,author,attribution,license_name,license_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (file_id) DO NOTHING`, existingFileID, item.TitleEN, item.TitleDA+" "+item.TitleEN, item.Category, ownerID, item.CommonsFilename, item.CommonsPage, info.URL, info.Author, info.Attribution, info.License, info.LicenseURL)
		} else {
			created, uploadErr := fileService.Upload(ctx, files.UploadParams{OwnerID: ownerID, Name: item.CommonsFilename, MimeType: "image/gif", ContentLength: int64(len(blob))}, bytes.NewReader(blob))
			if uploadErr != nil {
				panic(uploadErr)
			}
			_, err = pool.Exec(ctx, `INSERT INTO room_gif_library(file_id,title,search_terms,category,created_by,commons_filename,commons_page,commons_source_url,author,attribution,license_name,license_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, created.ID, item.TitleEN, item.TitleDA+" "+item.TitleEN, item.Category, ownerID, item.CommonsFilename, item.CommonsPage, info.URL, info.Author, info.Attribution, info.License, info.LicenseURL)
		}
		if err != nil {
			panic(err)
		}
		fmt.Printf("imported %s\n", item.CommonsFilename)
		time.Sleep(2 * time.Second)
	}
}
