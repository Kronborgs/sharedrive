package rooms

import (
  "context"
  "errors"
  "html"
  "io"
  "net"
  "net/http"
  "net/url"
  "regexp"
  "strings"
  "time"

  "github.com/yourname/privatedrive/internal/httputil"
  "github.com/yourname/privatedrive/internal/ratelimit"
)

const linkPreviewMaxBody = 512 * 1024
var ( linkMetaTag = regexp.MustCompile(`(?is)<meta\b[^>]*>`); linkTitle = regexp.MustCompile(`(?is)<title\b[^>]*>(.*?)</title>`); linkAttribute = regexp.MustCompile(`(?is)([a-z][a-z0-9:-]*)\s*=\s*["']([^"']*)["']`) )
type LinkPreview struct { URL string `json:"url"`; CanonicalURL string `json:"canonical_url,omitempty"`; Title string `json:"title,omitempty"`; Description string `json:"description,omitempty"`; ImageURL string `json:"image_url,omitempty"`; Hostname string `json:"hostname"` }
func (handler *Handler) GetGuestLinkPreview(w http.ResponseWriter, request *http.Request) {
  if !handler.validGuestOrigin(request) { httputil.RespondError(w, http.StatusForbidden, "request origin is not allowed"); return }
  access, ok := handler.guestAccess(w, request); if !ok { return }
  if !handler.allowRoomAction(request.Context(), ratelimit.KeyGuestRoomMutation, access.SessionID.String(), 30, time.Minute) { httputil.RespondError(w, http.StatusTooManyRequests, "guest room rate limit exceeded"); return }
  handler.GetLinkPreview(w, request)
}

func (handler *Handler) GetLinkPreview(w http.ResponseWriter, request *http.Request) { preview, err := fetchLinkPreview(request.Context(), strings.TrimSpace(request.URL.Query().Get("url"))); if err != nil { httputil.RespondError(w, http.StatusBadRequest, "link preview unavailable"); return }; httputil.Respond(w, http.StatusOK, preview) }
func fetchLinkPreview(parent context.Context, raw string) (LinkPreview, error) { target, err := validatePreviewURL(parent, raw); if err != nil { return LinkPreview{}, err }; ctx, cancel := context.WithTimeout(parent, 5*time.Second); defer cancel(); client := &http.Client{Timeout: 5*time.Second, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, DialContext: safePreviewDialer{}.DialContext, TLSHandshakeTimeout: 3*time.Second, ResponseHeaderTimeout: 3*time.Second}, CheckRedirect: func(req *http.Request, _ []*http.Request) error { _, e := validatePreviewURL(req.Context(), req.URL.String()); return e }}; req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil); if err != nil { return LinkPreview{}, err }; req.Header.Set("User-Agent", "Sharedrive link preview/1.0"); req.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9"); response, err := client.Do(req); if err != nil { return LinkPreview{}, err }; defer response.Body.Close(); if response.StatusCode < 200 || response.StatusCode >= 300 { return LinkPreview{}, errors.New("preview target returned an error") }; contentType := strings.ToLower(response.Header.Get("Content-Type")); if contentType != "" && !strings.Contains(contentType, "text/html") && !strings.Contains(contentType, "application/xhtml+xml") { return LinkPreview{}, errors.New("preview target is not html") }; body, err := io.ReadAll(io.LimitReader(response.Body, linkPreviewMaxBody)); if err != nil { return LinkPreview{}, err }; return parseLinkPreview(target, string(body)), nil }
func validatePreviewURL(ctx context.Context, raw string) (*url.URL, error) { target, err := url.ParseRequestURI(raw); if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Hostname() == "" || target.User != nil { return nil, errors.New("invalid preview URL") }; if err := ensurePublicHostname(ctx, target.Hostname()); err != nil { return nil, err }; return target, nil }
func ensurePublicHostname(ctx context.Context, hostname string) error { if ip := net.ParseIP(hostname); ip != nil { if !isPublicIP(ip) { return errors.New("preview host is not public") }; return nil }; lookupCtx, cancel := context.WithTimeout(ctx, 2*time.Second); defer cancel(); ips, err := net.DefaultResolver.LookupIP(lookupCtx, "ip", hostname); if err != nil || len(ips) == 0 { return errors.New("preview host cannot be resolved") }; for _, ip := range ips { if !isPublicIP(ip) { return errors.New("preview host is not public") } }; return nil }
func isPublicIP(ip net.IP) bool { return ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() && !ip.IsUnspecified() }
type safePreviewDialer struct{}
func (safePreviewDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) { host, port, err := net.SplitHostPort(address); if err != nil { return nil, err }; lookupCtx, cancel := context.WithTimeout(ctx, 2*time.Second); defer cancel(); ips, err := net.DefaultResolver.LookupIP(lookupCtx, "ip", host); if err != nil { return nil, err }; for _, ip := range ips { if !isPublicIP(ip) { continue }; conn, dialErr := (&net.Dialer{Timeout: 3*time.Second}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port)); if dialErr == nil { return conn, nil } }; return nil, errors.New("preview host is not public") }
func parseLinkPreview(target *url.URL, source string) LinkPreview { preview := LinkPreview{URL: target.String(), Hostname: target.Hostname()}; if match := linkTitle.FindStringSubmatch(source); len(match) > 1 { preview.Title = cleanPreviewText(match[1], 200) }; for _, tag := range linkMetaTag.FindAllString(source, -1) { attrs := map[string]string{}; for _, match := range linkAttribute.FindAllStringSubmatch(tag, -1) { attrs[strings.ToLower(match[1])] = html.UnescapeString(strings.TrimSpace(match[2])) }; key := strings.ToLower(attrs["property"]); if key == "" { key = strings.ToLower(attrs["name"]) }; value := cleanPreviewText(attrs["content"], 400); switch key { case "og:title": preview.Title = value; case "og:description", "description": preview.Description = value; case "og:image": preview.ImageURL = absolutePreviewURL(target, attrs["content"]); case "og:url": preview.CanonicalURL = absolutePreviewURL(target, attrs["content"]) } }; if preview.CanonicalURL == "" { preview.CanonicalURL = target.String() }; return preview }
func cleanPreviewText(value string, limit int) string { value = strings.Join(strings.Fields(html.UnescapeString(value)), " "); if len(value) > limit { return value[:limit] }; return value }
func absolutePreviewURL(base *url.URL, raw string) string { parsed, err := url.Parse(strings.TrimSpace(raw)); if err != nil || (parsed.Scheme != "" && parsed.Scheme != "http" && parsed.Scheme != "https") { return "" }; resolved := base.ResolveReference(parsed); if (resolved.Scheme != "http" && resolved.Scheme != "https") || resolved.Hostname() == "" { return "" }; return resolved.String() }