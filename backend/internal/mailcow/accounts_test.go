package mailcow

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	mw "github.com/yourname/privatedrive/internal/middleware"
	"github.com/yourname/privatedrive/internal/user"
)

type memoryAccounts map[uuid.UUID]storedAccount

func (m memoryAccounts) load(_ context.Context, owner uuid.UUID) (storedAccount, error) {
	if row, ok := m[owner]; ok {
		return row, nil
	}
	return storedAccount{}, errNotConnected
}

func (m memoryAccounts) save(_ context.Context, owner uuid.UUID, row storedAccount) error {
	m[owner] = row
	return nil
}

func (m memoryAccounts) remove(_ context.Context, owner uuid.UUID) error {
	delete(m, owner)
	return nil
}

const accountTestPassword = "test-only-mailcow-password"

type wireAccount struct {
	credentials
	Host string `json:"host"`
}

func TestAccountRequestsUseOnlyTheCurrentUsersSavedHostAndCredentials(t *testing.T) {
	requests := make(chan wireAccount, 2)
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input wireAccount
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error("could not decode probe payload")
		}
		requests <- input
		_, _ = w.Write([]byte(`{"imap":"ok","smtp":"ok","caldav":"ok","carddav":"ok"}`))
	}))
	defer sidecar.Close()
	store := make(memoryAccounts)
	probe := NewProbe(sidecar.Listener.Addr().(*net.TCPAddr).Port, testToken, &memoryHost{host: "admin.example.test"})
	handler := Accounts{store: store, probe: probe, aead: makeAccountCipher(strings.Repeat("12", 32)), moduleEnabled: func(context.Context) (bool, error) { return true, nil }}
	alice, bob := uuid.New(), uuid.New()

	assertSavedMailcowConnection(t, handler, store, requests, alice, "mail-alice.example.test")
	assertSavedMailcowConnection(t, handler, store, requests, bob, "mail-bob.example.test")
	if got := requestAccount(alice, http.MethodGet, "", handler.Get, true); got.Code != http.StatusForbidden {
		t.Fatal("support session obtained account access")
	}
	originalBob := store[bob]
	swapped := store[alice]
	store[bob] = swapped
	if got := requestAccount(bob, http.MethodPost, `{}`, handler.Test, false); got.Code != http.StatusInternalServerError {
		t.Fatal("a different user could decrypt the copied record")
	}
	store[bob] = originalBob
	if got := requestAccount(alice, http.MethodDelete, "", handler.Remove, false); got.Code != http.StatusNoContent {
		t.Fatal("account was not disconnected")
	}
	if got := requestAccount(alice, http.MethodGet, "", handler.Get, false); !strings.Contains(got.Body.String(), `"account":null`) {
		t.Fatal("disconnected account still appeared")
	}
	if got := requestAccount(bob, http.MethodGet, "", handler.Get, false); !strings.Contains(got.Body.String(), "mail-bob.example.test") ||
		strings.Contains(got.Body.String(), accountTestPassword) {
		t.Fatal("disconnect affected the other user or returned its password")
	}
}

func requestAccount(id uuid.UUID, method, body string, handle http.HandlerFunc, support bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/api/v1/me/mailcow", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	ctx := mw.WithUser(r.Context(), &user.User{ID: id, Role: "user"})
	if support {
		ctx = mw.WithSupportMode(ctx)
	}
	w := httptest.NewRecorder()
	handle(w, r.WithContext(ctx))
	return w
}

func assertSavedMailcowConnection(t *testing.T, handler Accounts, store memoryAccounts, requests <-chan wireAccount, id uuid.UUID, host string) {
	t.Helper()

	body := `{"host":"` + host + `","username":"mailbox@example.test","password":"` + accountTestPassword + `"}`
	if got := requestAccount(id, http.MethodPut, body, handler.Save, false); got.Code != http.StatusOK ||
		strings.Contains(got.Body.String(), accountTestPassword) ||
		strings.Contains(string(store[id].encryptedPassword), accountTestPassword) {
		t.Fatalf("account was not stored safely: %d", got.Code)
	}
	if input := <-requests; input.Host != host {
		t.Fatal("setup did not probe the selected host")
	}
	if got := requestAccount(id, http.MethodPost, `{}`, handler.Test, false); got.Code != http.StatusOK {
		t.Fatalf("probe failed: %d %s", got.Code, got.Body)
	}
	select {
	case input := <-requests:
		if input.Host != host || input.Password != accountTestPassword || input.Username != "mailbox@example.test" {
			t.Fatal("probe did not use the owning user's saved connection")
		}
	default:
		t.Fatal("probe did not contact the test sidecar")
	}
}

func TestDisabledModuleRejectsUserOperations(t *testing.T) {
	handler := Accounts{
		store:         make(memoryAccounts),
		probe:         NewProbe(3025, testToken, &memoryHost{}),
		aead:          makeAccountCipher(strings.Repeat("12", 32)),
		moduleEnabled: func(context.Context) (bool, error) { return false, nil },
	}
	owner := uuid.New()
	for _, endpoint := range []struct {
		method string
		body   string
		handle http.HandlerFunc
	}{
		{http.MethodPut, `{"host":"mail.example.test","username":"mailbox@example.test","password":"fixture"}`, handler.Save},
		{http.MethodPost, `{}`, handler.Test},
		{http.MethodGet, "", handler.Operation("inbox")},
	} {
		response := requestAccount(owner, endpoint.method, endpoint.body, endpoint.handle, false)
		if response.Code != http.StatusServiceUnavailable {
			t.Errorf("%s returned %d, want 503", endpoint.method, response.Code)
		}
	}
}
