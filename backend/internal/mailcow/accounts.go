package mailcow

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/yourname/privatedrive/internal/httputil"
	mw "github.com/yourname/privatedrive/internal/middleware"
)

var errNotConnected = errors.New("Mailcow account is not connected")

type accountSummary struct {
	Host     string `json:"host"`
	Username string `json:"username"`
}

type storedAccount struct {
	accountSummary
	encryptedPassword []byte
}

type accountStore interface {
	load(context.Context, uuid.UUID) (storedAccount, error)
	save(context.Context, uuid.UUID, storedAccount) error
	remove(context.Context, uuid.UUID) error
}

type postgresAccounts struct{ db *pgxpool.Pool }

func (s postgresAccounts) load(ctx context.Context, owner uuid.UUID) (storedAccount, error) {
	var account storedAccount
	err := s.db.QueryRow(ctx, `SELECT host, username, encrypted_password
		FROM user_mailcow_accounts WHERE user_id = $1`, owner).
		Scan(&account.Host, &account.Username, &account.encryptedPassword)
	if errors.Is(err, pgx.ErrNoRows) {
		return storedAccount{}, errNotConnected
	}
	return account, err
}

func (s postgresAccounts) save(ctx context.Context, owner uuid.UUID, account storedAccount) error {
	_, err := s.db.Exec(ctx, `INSERT INTO user_mailcow_accounts (user_id, host, username, encrypted_password)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id) DO UPDATE SET host = EXCLUDED.host, username = EXCLUDED.username,
		encrypted_password = EXCLUDED.encrypted_password`,
		owner, account.Host, account.Username, account.encryptedPassword)
	return err
}

func (s postgresAccounts) remove(ctx context.Context, owner uuid.UUID) error {
	_, err := s.db.Exec(ctx, "DELETE FROM user_mailcow_accounts WHERE user_id = $1", owner)
	return err
}

type Accounts struct {
	store         accountStore
	probe         *Probe
	aead          cipher.AEAD
	moduleEnabled func(context.Context) (bool, error)
}

func NewAccounts(db *pgxpool.Pool, probe *Probe, installationKey string, module Module) *Accounts {
	return &Accounts{store: postgresAccounts{db}, probe: probe, aead: makeAccountCipher(installationKey), moduleEnabled: module.Enabled}
}

func makeAccountCipher(installationKey string) cipher.AEAD {
	key, err := hex.DecodeString(installationKey)
	if err != nil || len(key) != 32 {
		return nil
	}
	derived, err := hkdf.Key(sha256.New, key, nil, "sharedrive/mailcow/account/v1", 32)
	if err != nil {
		return nil
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		return nil
	}
	aead, _ := cipher.NewGCMWithRandomNonce(block)
	return aead
}

func accountAAD(owner uuid.UUID, account accountSummary) []byte {
	return []byte(owner.String() + "\x00" + account.Host + "\x00" + account.Username)
}

func accountOwner(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	w.Header().Set("Cache-Control", "no-store")
	current := mw.UserFromContext(r.Context())
	if current == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "Authentication required")
		return uuid.Nil, false
	}
	if current.RoomsOnlyAccount || current.Role == "guest" || mw.IsSupportMode(r.Context()) {
		httputil.RespondError(w, http.StatusForbidden, "Mailcow account access is unavailable")
		return uuid.Nil, false
	}
	return current.ID, true
}

func (h *Accounts) ready() bool {
	return h.aead != nil && h.probe.client != nil
}

func (h *Accounts) Get(w http.ResponseWriter, r *http.Request) {
	owner, ok := accountOwner(w, r)
	if !ok {
		return
	}
	enabled, err := h.moduleEnabled(r.Context())
	if err != nil {
		accountError(w)
		return
	}
	account, err := h.store.load(r.Context(), owner)
	if err != nil && !errors.Is(err, errNotConnected) {
		accountError(w)
		return
	}
	var summary *accountSummary
	if err == nil {
		summary = &account.accountSummary
	}
	httputil.Respond(w, http.StatusOK, struct {
		Enabled bool            `json:"enabled"`
		Ready   bool            `json:"ready"`
		Account *accountSummary `json:"account"`
	}{enabled, h.ready(), summary})
}

func (h *Accounts) Save(w http.ResponseWriter, r *http.Request) {
	owner, ok := accountOwner(w, r)
	if !ok {
		return
	}
	if !h.requireModule(w, r) {
		return
	}
	if !isJSON(r) {
		httputil.RespondError(w, http.StatusUnsupportedMediaType, "Mailcow requests must use application/json")
		return
	}
	var input struct {
		credentials
		Host string `json:"host"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPayload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(json.RawMessage)) != io.EOF {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid Mailcow account")
		return
	}
	host := strings.ToLower(strings.TrimSpace(input.Host))
	input.Username = strings.TrimSpace(input.Username)
	if !validHost(host) || !input.credentials.valid() {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid Mailcow account")
		return
	}
	protocols, ok := h.probe.test(w, r, host, input.credentials)
	if !ok {
		return
	}
	type connectResult struct {
		Account   *accountSummary `json:"account"`
		Protocols probeResult     `json:"protocols"`
	}
	if protocols.IMAP != "ok" || protocols.SMTP != "ok" || protocols.CalDAV != "ok" || protocols.CardDAV != "ok" {
		httputil.Respond(w, http.StatusOK, connectResult{Protocols: protocols})
		return
	}

	summary := accountSummary{Host: host, Username: input.Username}
	encrypted := h.aead.Seal(nil, nil, []byte(input.Password), accountAAD(owner, summary))
	if err := h.store.save(r.Context(), owner, storedAccount{summary, encrypted}); err != nil {
		accountError(w)
		return
	}
	httputil.Respond(w, http.StatusOK, connectResult{Account: &summary, Protocols: protocols})
}

func (h *Accounts) Remove(w http.ResponseWriter, r *http.Request) {
	owner, ok := accountOwner(w, r)
	if !ok {
		return
	}
	if err := h.store.remove(r.Context(), owner); err != nil {
		accountError(w)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Accounts) Test(w http.ResponseWriter, r *http.Request) {
	owner, ok := accountOwner(w, r)
	if !ok {
		return
	}
	if !h.requireModule(w, r) {
		return
	}
	// The JSON media type keeps cross-site HTML forms from triggering a probe.
	if !isJSON(r) {
		httputil.RespondError(w, http.StatusUnsupportedMediaType, "Mailcow requests must use application/json")
		return
	}
	account, err := h.store.load(r.Context(), owner)
	if errors.Is(err, errNotConnected) {
		httputil.RespondError(w, http.StatusNotFound, "No Mailcow account is connected")
		return
	}
	if err != nil {
		accountError(w)
		return
	}
	password, err := h.aead.Open(nil, nil, account.encryptedPassword, accountAAD(owner, account.accountSummary))
	if err != nil {
		accountError(w)
		return
	}
	h.probe.replyProbe(w, r, account.Host, credentials{Username: account.Username, Password: string(password)})
}

func accountError(w http.ResponseWriter) {
	httputil.RespondError(w, http.StatusInternalServerError, "Mailcow account could not be accessed")
}
