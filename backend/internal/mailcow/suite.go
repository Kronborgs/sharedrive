package mailcow

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/yourname/privatedrive/internal/httputil"
	mw "github.com/yourname/privatedrive/internal/middleware"
)

const (
	suitePayloadLimit = 25 << 20
	contentTypeHeader = "Content-Type"
)

var calendarLinkToken = regexp.MustCompile(`^[A-Za-z0-9_-]{24}$`)

var suitePath = regexp.MustCompile(`^(mail|caldav|carddav)/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*$`)

func allowedSuitePath(path string) bool {
	return path == "auth/config" || path == "auth/session" || suitePath.MatchString(path)
}

func (h *Accounts) Suite(w http.ResponseWriter, r *http.Request) {
	owner, ok := accountOwner(w, r)
	if !ok || !h.requireModule(w, r) {
		return
	}
	path := chi.URLParam(r, "*")
	if !allowedSuitePath(path) {
		httputil.RespondError(w, http.StatusNotFound, "Unknown Mailcow operation")
		return
	}
	if r.ContentLength > suitePayloadLimit {
		httputil.RespondError(w, http.StatusRequestEntityTooLarge, "Mailcow request is too large")
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
	h.forwardSuite(w, r, path, owner, account.accountSummary, password)
}

func (h *Accounts) suiteScope(owner uuid.UUID, account accountSummary) string {
	scope := hmac.New(sha256.New, h.scopeSecret[:])
	_, _ = scope.Write(accountAAD(owner, account))
	return hex.EncodeToString(scope.Sum(nil))
}

type calendarLinkOwner struct {
	Owner uuid.UUID `json:"owner"`
	Scope string    `json:"scope"`
}

func (h *Accounts) PublicCalendar(w http.ResponseWriter, r *http.Request) {
	w.Header().Set(cacheControlHeader, noStore)
	if !h.requireModule(w, r) {
		return
	}
	token := chi.URLParam(r, "token")
	if !calendarLinkToken.MatchString(token) {
		calendarLinkUnavailable(w)
		return
	}
	link, err := h.lookupCalendarLink(r, token)
	if err != nil {
		calendarLinkUnavailable(w)
		return
	}
	account, err := h.store.load(r.Context(), link.Owner)
	if err != nil || !hmac.Equal([]byte(link.Scope), []byte(h.suiteScope(link.Owner, account.accountSummary))) {
		calendarLinkUnavailable(w)
		return
	}
	password, err := h.aead.Open(nil, nil, account.encryptedPassword, accountAAD(link.Owner, account.accountSummary))
	if err != nil {
		calendarLinkUnavailable(w)
		return
	}
	h.forwardSuite(w, r, "caldav/public/"+token, link.Owner, account.accountSummary, password)
}

func calendarLinkUnavailable(w http.ResponseWriter) {
	httputil.RespondError(w, http.StatusNotFound, "Calendar link is unavailable")
}

func (h *Accounts) suiteURL(path string) string {
	return strings.TrimSuffix(h.probe.target, "/internal/v1/probe") + "/suite/api/" + path
}

func (h *Accounts) lookupCalendarLink(r *http.Request, token string) (calendarLinkOwner, error) {
	var link calendarLinkOwner
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, h.suiteURL("link-owner/"+token), nil)
	if err != nil {
		return link, err
	}
	request.Header.Set("Authorization", "Bearer "+h.probe.token)
	response, err := h.probe.client.Do(request)
	if err != nil {
		return link, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return link, errNotConnected
	}
	err = json.NewDecoder(io.LimitReader(response.Body, 512)).Decode(&link)
	return link, err
}

func (h *Accounts) forwardSuite(w http.ResponseWriter, r *http.Request, path string, owner uuid.UUID, account accountSummary, password []byte) {
	bridge, err := json.Marshal(struct {
		accountSummary
		Password string `json:"password"`
		calendarLinkOwner
	}{account, string(password), calendarLinkOwner{Owner: owner, Scope: h.suiteScope(owner, account)}})
	if err != nil {
		accountError(w)
		return
	}

	target, err := url.Parse(h.suiteURL(path))
	if err != nil {
		accountError(w)
		return
	}
	target.RawQuery = r.URL.RawQuery
	request, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(),
		http.MaxBytesReader(w, r.Body, suitePayloadLimit))
	if err != nil {
		accountError(w)
		return
	}
	request.Header.Set("Authorization", "Bearer "+h.probe.token)
	request.Header.Set("X-Sharedrive-Mailcow-Account", base64.RawURLEncoding.EncodeToString(bridge))
	request.Header.Set(contentTypeHeader, r.Header.Get(contentTypeHeader))
	if ip := net.ParseIP(mw.ClientIP(r)); ip != nil {
		request.Header.Set("X-Sharedrive-Client-IP", ip.String())
	}
	upstream, err := h.probe.client.Do(request)
	if err != nil {
		httputil.RespondError(w, http.StatusBadGateway, errProbeUnavailable)
		return
	}
	defer upstream.Body.Close()
	writeSuiteResponse(w, upstream, path == "mail/attachment" && r.URL.Query().Get("inline") == "1")
}

const contentDispositionHeader = "Content-Disposition"

func inlineMailAttachment(contentType, disposition string) (string, string) {
	kind, params, err := mime.ParseMediaType(disposition)
	if err != nil || kind != "attachment" {
		return contentType, disposition
	}
	mediaType, _, _ := mime.ParseMediaType(contentType)
	if mediaType == "application/octet-stream" {
		mediaType, _, _ = mime.ParseMediaType(mime.TypeByExtension(filepath.Ext(params["filename"])))
	}
	switch mediaType {
	case "application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/flac", "audio/mp4", "video/mp4", "video/webm", "video/ogg", "video/quicktime":
		return mediaType, mime.FormatMediaType("inline", params)
	default:
		return contentType, disposition
	}
}

func writeSuiteResponse(w http.ResponseWriter, response *http.Response, allowInlineAttachment bool) {
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		httputil.RespondError(w, http.StatusBadGateway, errProbeUnavailable)
		return
	}
	contentType := response.Header.Get(contentTypeHeader)
	disposition := response.Header.Get(contentDispositionHeader)
	if !strings.HasPrefix(contentType, "application/json") && !strings.HasPrefix(strings.ToLower(disposition), "attachment;") {
		httputil.RespondError(w, http.StatusBadGateway, errProbeUnavailable)
		return
	}
	if allowInlineAttachment {
		contentType, disposition = inlineMailAttachment(contentType, disposition)
	}
	header := w.Header()
	header.Set(contentTypeHeader, contentType)
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	if disposition != "" {
		header.Set(contentDispositionHeader, disposition)
		if length := response.Header.Get("Content-Length"); length != "" {
			header.Set("Content-Length", length)
		}
	}
	w.WriteHeader(response.StatusCode)
	if disposition != "" {
		_, _ = io.Copy(w, response.Body)
		return
	}
	_, _ = io.CopyN(w, response.Body, 32<<20)
}
