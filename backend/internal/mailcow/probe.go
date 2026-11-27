package mailcow

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/yourname/privatedrive/internal/httputil"
)

const (
	maxPayload            = 4096
	cacheControlHeader    = "Cache-Control"
	noStore               = "no-store"
	errInvalidCredentials = "Invalid Mailcow credentials"
	errProbeUnavailable   = "Mailcow connection test is unavailable"
)

var hostname = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

var probeToken = regexp.MustCompile(`^[A-Za-z0-9_-]{32,}$`)
var mailbox = regexp.MustCompile("^[A-Za-z0-9.!#$%&'*+=?^_`{|}~-]+@[A-Za-z0-9.-]+$")

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type probeResult struct {
	IMAP    string `json:"imap"`
	SMTP    string `json:"smtp"`
	CalDAV  string `json:"caldav"`
	CardDAV string `json:"carddav"`
}

// Probe is the Go boundary for the loopback-only Mailcow diagnostic.
type Probe struct {
	store  HostStore
	target string
	token  string
	client *http.Client
}

func NewProbe(port int, token string, store HostStore) *Probe {
	p := &Probe{store: store}
	if port < 1 || port > 65535 || !probeToken.MatchString(token) {
		return p
	}
	p.target = (&url.URL{
		Scheme: "http",
		Host:   "127.0.0.1:" + strconv.Itoa(port),
		Path:   "/internal/v1/probe",
	}).String()
	p.token = token
	p.client = &http.Client{
		Timeout: 40 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return p
}

type probeSettings struct {
	Enabled bool   `json:"enabled"`
	Host    string `json:"host"`
}

func (p *Probe) Settings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set(cacheControlHeader, noStore)
	host, err := p.store.LoadHost(r.Context())
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "Mailcow settings are unavailable")
		return
	}
	httputil.Respond(w, http.StatusOK, probeSettings{Enabled: p.client != nil, Host: host})
}

func (p *Probe) UpdateHost(w http.ResponseWriter, r *http.Request) {
	w.Header().Set(cacheControlHeader, noStore)
	if !isJSON(r) {
		httputil.RespondError(w, http.StatusUnsupportedMediaType, "Mailcow requests must use application/json")
		return
	}
	body := struct {
		Host *string `json:"host"`
	}{}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || decoder.Decode(new(json.RawMessage)) != io.EOF || body.Host == nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid Mailcow host")
		return
	}
	host := strings.ToLower(strings.TrimSpace(*body.Host))
	if host != "" && !validHost(host) {
		httputil.RespondError(w, http.StatusBadRequest, "Enter a Mailcow DNS hostname without a scheme or port")
		return
	}
	if err := p.store.SaveHost(r.Context(), host); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "Mailcow settings could not be saved")
		return
	}
	httputil.Respond(w, http.StatusOK, probeSettings{Enabled: p.client != nil, Host: host})
}

func validHost(host string) bool {
	return len(host) <= 253 && hostname.MatchString(host)
}

func isJSON(r *http.Request) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && mediaType == "application/json"
}

func (p *Probe) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set(cacheControlHeader, noStore)
	if p.client == nil {
		httputil.RespondError(w, http.StatusServiceUnavailable, "Mailcow connection test is not configured")
		return
	}

	if !isJSON(r) {
		httputil.RespondError(w, http.StatusUnsupportedMediaType, "Mailcow requests must use application/json")
		return
	}

	var account credentials
	body := http.MaxBytesReader(w, r.Body, maxPayload)
	decoder := json.NewDecoder(body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&account); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httputil.RespondError(w, http.StatusRequestEntityTooLarge, "Mailcow request is too large")
			return
		}
		httputil.RespondError(w, http.StatusBadRequest, errInvalidCredentials)
		return
	}
	if decoder.Decode(new(json.RawMessage)) != io.EOF || !account.valid() {
		httputil.RespondError(w, http.StatusBadRequest, errInvalidCredentials)
		return
	}

	host, err := p.store.LoadHost(r.Context())
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "Mailcow settings are unavailable")
		return
	}
	if !validHost(host) {
		httputil.RespondError(w, http.StatusServiceUnavailable, "Save a Mailcow hostname before running the test")
		return
	}
	p.replyProbe(w, r, host, account)
}

func (p *Probe) replyProbe(w http.ResponseWriter, r *http.Request, host string, account credentials) {
	result, ok := p.test(w, r, host, account)
	if ok {
		httputil.Respond(w, http.StatusOK, result)
	}
}

func (p *Probe) test(w http.ResponseWriter, r *http.Request, host string, account credentials) (probeResult, bool) {
	data, ok := p.operation(w, r, "probe", host, account, nil)
	var result probeResult
	if !ok {
		return result, false
	}
	if json.Unmarshal(data, &result) != nil || !result.valid() {
		httputil.RespondError(w, http.StatusBadGateway, errProbeUnavailable)
		return probeResult{}, false
	}
	return result, true
}

func (p *Probe) operation(w http.ResponseWriter, r *http.Request, operation, host string, account credentials, arguments json.RawMessage) (json.RawMessage, bool) {
	data, err := json.Marshal(struct {
		credentials
		Host      string          `json:"host"`
		Arguments json.RawMessage `json:"arguments,omitempty"`
	}{account, host, arguments})
	if err != nil || len(data) > 96*1024 {
		httputil.RespondError(w, http.StatusBadRequest, errInvalidCredentials)
		return nil, false
	}
	target := strings.TrimSuffix(p.target, "probe") + operation
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, target, bytes.NewReader(data))
	if err != nil {
		httputil.RespondError(w, http.StatusBadGateway, errProbeUnavailable)
		return nil, false
	}
	request.Header.Set("Authorization", "Bearer "+p.token)
	request.Header.Set("Content-Type", "application/json")

	response, err := p.client.Do(request)
	if err != nil {
		httputil.RespondError(w, http.StatusBadGateway, errProbeUnavailable)
		return nil, false
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusTooManyRequests {
		httputil.RespondError(w, http.StatusTooManyRequests, "A Mailcow request is already running")
		return nil, false
	}
	if response.StatusCode == http.StatusBadRequest && operation != "probe" {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid Mailcow request")
		return nil, false
	}

	payload, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if response.StatusCode != http.StatusOK || err != nil || !json.Valid(payload) {
		httputil.RespondError(w, http.StatusBadGateway, errProbeUnavailable)
		return nil, false
	}
	return payload, true
}

func (c credentials) valid() bool {
	return len(c.Username) <= 254 && mailbox.MatchString(c.Username) &&
		len(c.Password) > 0 && len(c.Password) <= 1024 &&
		strings.IndexFunc(c.Password, func(r rune) bool { return r < 32 || r == 127 }) < 0
}

func (r probeResult) valid() bool {
	for _, value := range []string{r.IMAP, r.SMTP, r.CalDAV, r.CardDAV} {
		if value != "ok" && value != "failed" {
			return false
		}
	}
	return true
}
