package mailcow

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type memoryHost struct{ host string }

func (m *memoryHost) LoadHost(context.Context) (string, error) { return m.host, nil }
func (m *memoryHost) SaveHost(_ context.Context, host string) error {
	m.host = host
	return nil
}

const testToken = "mailcow-test-token-0123456789abcdef"

func TestProbeForwardsOnlyToConfiguredService(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/v1/probe" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Error("unexpected upstream path, method or authentication")
		}
		var account struct {
			credentials
			Host string `json:"host"`
		}
		if err := json.NewDecoder(r.Body).Decode(&account); err != nil ||
			account.Username != "first@example.test" || account.Password != "dummy" || account.Host != "mail.example.test" {
			t.Error("unexpected credentials sent to the test service")
		}
		_, _ = w.Write([]byte(`{"imap":"ok","smtp":"ok","caldav":"failed","carddav":"ok","extra":"PRIVATE"}`))
	}))
	defer sidecar.Close()
	probe := NewProbe(sidecar.Listener.Addr().(*net.TCPAddr).Port, testToken, &memoryHost{host: "mail.example.test"})

	result := requestProbe(probe, `{"username":"first@example.test","password":"dummy"}`)
	if result.Code != http.StatusOK || result.Header().Get("Cache-Control") != "no-store" ||
		strings.Contains(result.Body.String(), "PRIVATE") || !strings.Contains(result.Body.String(), `"caldav":"failed"`) {
		t.Errorf("unexpected status response: %d %s", result.Code, result.Body)
	}
}

func TestProbeRejectsUnexpectedInputAndRedirect(t *testing.T) {
	var calls int
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.Redirect(w, r, "/elsewhere", http.StatusTemporaryRedirect)
	}))
	defer sidecar.Close()
	probe := NewProbe(sidecar.Listener.Addr().(*net.TCPAddr).Port, testToken, &memoryHost{host: "mail.example.test"})

	valid := `{"username":"first@example.test","password":"dummy"}`
	for _, body := range []string{valid + valid, `{"username":"first@example.test","password":"dummy","host":"elsewhere"}`} {
		if result := requestProbe(probe, body); result.Code != http.StatusBadRequest {
			t.Errorf("unexpected status for invalid payload: %d", result.Code)
		}
	}
	if calls != 0 {
		t.Fatal("invalid payload reached the test service")
	}
	if result := requestProbe(probe, valid); result.Code != http.StatusBadGateway || calls != 1 {
		t.Fatalf("redirect must not be followed: status %d, calls %d", result.Code, calls)
	}
	if result := requestProbe(NewProbe(3025, "", &memoryHost{}), valid); result.Code != http.StatusServiceUnavailable {
		t.Errorf("unexpected status for disabled test: %d", result.Code)
	}
}

func requestProbe(probe *Probe, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/admin/settings/mailcow-test", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	result := httptest.NewRecorder()
	probe.ServeHTTP(result, request)
	return result
}

func TestMailcowHostIsSavedNormalizedAndRejectsURLs(t *testing.T) {
	store := &memoryHost{}
	probe := NewProbe(3025, "", store)
	request := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPatch, "/", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		probe.UpdateHost(res, req)
		return res
	}
	if res := request(`{"host":" MAIL.Example.TEST "}`); res.Code != http.StatusOK || store.host != "mail.example.test" {
		t.Fatalf("host was not saved: %d, %q", res.Code, store.host)
	}
	if res := request(`{"host":"https://mail.example.test"}`); res.Code != http.StatusBadRequest || store.host != "mail.example.test" {
		t.Fatalf("invalid host changed setting: %d, %q", res.Code, store.host)
	}
}
