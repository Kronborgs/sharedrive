package rooms

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestStarterGIFManifestIsValid(t *testing.T) {
	var items []starterGIF
	if err := json.Unmarshal(starterGIFManifest, &items); err != nil {
		t.Fatalf("decode starter GIF manifest: %v", err)
	}
	if len(items) < 100 {
		t.Fatalf("starter GIF manifest contains only %d entries", len(items))
	}
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		if strings.TrimSpace(item.CommonsFilename) == "" || strings.TrimSpace(item.CommonsPage) == "" || strings.TrimSpace(item.Category) == "" {
			t.Fatalf("starter GIF has incomplete source identity: %+v", item)
		}
		if !starterLicenseOK(item.ExpectedLicense) {
			t.Fatalf("starter GIF %q has unsupported license %q", item.CommonsFilename, item.ExpectedLicense)
		}
		if _, exists := seen[item.CommonsFilename]; exists {
			t.Fatalf("duplicate starter GIF filename %q", item.CommonsFilename)
		}
		seen[item.CommonsFilename] = struct{}{}
	}
}

func TestStarterGIFSearchTermsIncludeBothLanguages(t *testing.T) {
	item := starterGIF{CommonsFilename: "reaction.gif", TitleDA: "Godt gået", TitleEN: "Well done", TagsDA: []string{"flot"}, TagsEN: []string{"bravo"}}
	terms := starterGIFSearchTerms(item)
	for _, expected := range []string{"starter-gif:", "Godt gået", "Well done", "flot", "bravo"} {
		if !strings.Contains(terms, expected) {
			t.Fatalf("search terms %q do not contain %q", terms, expected)
		}
	}
}

func TestStarterGETRetriesRateLimit(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			writer.Header().Set("Retry-After", "1")
			writer.WriteHeader(http.StatusTooManyRequests)
			return
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	response, err := starterGET(context.Background(), server.Client(), server.URL)
	if err != nil {
		t.Fatalf("starterGET returned an error: %v", err)
	}
	response.Body.Close()
	if calls.Load() != 2 {
		t.Fatalf("starterGET made %d calls, want 2", calls.Load())
	}
}
