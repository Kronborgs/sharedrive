package mailcow

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func TestSuiteAttachmentDisposition(t *testing.T) {
	for _, tc := range []struct {
		name, contentType, filename, wantType, wantDisposition string
		inline                                                 bool
	}{
		{"PDF opens inline", "application/pdf", "oversigt.pdf", "application/pdf", "inline", true},
		{"generic photo opens inline", "application/octet-stream", "billede.png", "image/png", "inline", true},
		{"PDF download stays attachment", "application/pdf", "oversigt.pdf", "application/pdf", "attachment", false},
		{"HTML stays attachment", "text/html", "side.html", "text/html", "attachment", true},
		{"SVG stays attachment", "image/svg+xml", "billede.svg", "image/svg+xml", "attachment", true},
		{"archive stays attachment", "application/zip", "filer.zip", "application/zip", "attachment", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const content = "fixture attachment"
			headers := make(http.Header)
			headers.Set(contentTypeHeader, tc.contentType)
			headers.Set(contentDispositionHeader, mime.FormatMediaType("attachment", map[string]string{"filename": tc.filename}))
			result := httptest.NewRecorder()
			writeSuiteResponse(result, &http.Response{
				StatusCode: http.StatusOK, Header: headers, Body: io.NopCloser(strings.NewReader(content)),
			}, tc.inline)
			mode, params, err := mime.ParseMediaType(result.Header().Get(contentDispositionHeader))
			if err != nil || params["filename"] != tc.filename || mode != tc.wantDisposition {
				t.Errorf("attachment disposition %q", result.Header().Get(contentDispositionHeader))
			}
			if result.Header().Get(contentTypeHeader) != tc.wantType || result.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Errorf("unexpected response headers %v", result.Header())
			}
			if result.Body.String() != content {
				t.Error("attachment body was changed")
			}
		})
	}
}

func TestPublicCalendarUsesLinkOwnersConnectedAccount(t *testing.T) {
	owner := uuid.New()
	account := accountSummary{Host: "mail.example.test", Username: "owner@example.test"}
	handler := NewAccounts(nil, nil, strings.Repeat("23", 32), Module{})
	store := memoryAccounts{owner: {
		accountSummary:    account,
		encryptedPassword: handler.aead.Seal(nil, nil, []byte(accountTestPassword), accountAAD(owner, account)),
	}}
	handler.store = store
	handler.moduleEnabled = func(context.Context) (bool, error) { return true, nil }

	token := strings.Repeat("a", 24)
	link := calendarLinkOwner{Owner: owner, Scope: handler.suiteScope(owner, account)}
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/suite/api/link-owner/"+token {
			_ = json.NewEncoder(w).Encode(link)
			return
		}
		assertSuiteCalendarCredentials(t, r, link, account)
		_, _ = w.Write([]byte(`{"ok":true,"events":[]}`))
	}))
	defer sidecar.Close()
	handler.probe = &Probe{target: sidecar.URL + "/internal/v1/probe", client: sidecar.Client(), token: testToken}
	router := chi.NewRouter()
	router.Get("/public/{token}", handler.PublicCalendar)

	request := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/public/"+token, nil)
		r.Header.Set("Cookie", "untrusted-session=fixture")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	if w := request(); w.Code != http.StatusOK || strings.Contains(w.Body.String(), accountTestPassword) {
		t.Fatalf("expected public calendar without account credentials, status %d", w.Code)
	}
	updated := store[owner]
	updated.Host = "mail-new.example.test"
	store[owner] = updated
	if w := request(); w.Code != http.StatusNotFound {
		t.Fatalf("link for a different account scope returned %d", w.Code)
	}
	delete(store, owner)
	if w := request(); w.Code != http.StatusNotFound {
		t.Fatalf("link for a disconnected account returned %d", w.Code)
	}
}

func assertSuiteCalendarCredentials(t *testing.T, r *http.Request, link calendarLinkOwner, account accountSummary) {
	t.Helper()
	if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "Bearer "+testToken {
		t.Error("forwarded external authentication to sidecar")
	}
	payload, _ := base64.RawURLEncoding.DecodeString(r.Header.Get("X-Sharedrive-Mailcow-Account"))
	var wire struct {
		accountSummary
		calendarLinkOwner
		Password string
	}
	if json.Unmarshal(payload, &wire) != nil || wire.accountSummary != account ||
		wire.Password != accountTestPassword || wire.calendarLinkOwner != link {
		t.Error("sidecar did not receive the link owner's saved credentials")
	}
}
