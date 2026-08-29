package main

import (
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

func loadManifest(path string) ([]manifestItem, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var items []manifestItem
	if err := json.Unmarshal(data, &items); err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, errors.New("manifest contains no entries")
	}
	return items, nil
}

func validateManifestItem(item manifestItem, index int) error {
	if item.CommonsFilename == "" || item.CommonsPage == "" || item.Category == "" || !acceptedLicense(item.ExpectedLicense) {
		return fmt.Errorf("invalid manifest entry %d", index+1)
	}
	return nil
}

func libraryContains(ctx context.Context, pool interface {
	QueryRow(context.Context, string, ...any) interface{ Scan(...any) error }
}, filename string) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM room_gif_library WHERE commons_filename=$1)`, filename).Scan(&exists)
	return exists, err
}

func main() {
	manifestPath := flag.String("manifest", "internal/rooms/gif_starter_manifest.json", "reviewed Commons GIF manifest")
	apply := flag.Bool("apply", false, "download and import after all validation")
	flag.Parse()
	items, err := loadManifest(*manifestPath)
	if err != nil {
		panic(err)
	}
	if !*apply {
		fmt.Printf("Validated manifest with %d entries. Use --apply after deployment.\n", len(items))
		return
	}
	panic("apply flow is split into the next importer step")
}
