package middleware

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// inlineScriptRe matches the content of <script> tags that contain inline code.
// External scripts (<script src="..."></script>) have empty bodies and are skipped
// because the non-greedy `.+?` requires at least one byte between the tags.
// Vite injects a modulepreload polyfill as an inline script whose content changes
// with every build, so we compute hashes at startup rather than hardcoding them.
// Note: the script body may contain `<` (e.g. comparison operators) so we cannot
// use [^<]+ here — `.+?` with the (?s) flag handles that correctly.
var inlineScriptRe = regexp.MustCompile(`(?s)<script(?:\s[^>]*)?>(.+?)</script>`)

// InlineScriptHashes reads dist/index.html from the given FS and returns
// a 'sha256-XXXX=' hash string for every inline <script> block found.
// Pass the result into SecurityHeaders so the CSP stays correct after each build.
func InlineScriptHashes(distFS fs.FS) []string {
	data, err := fs.ReadFile(distFS, "dist/index.html")
	if err != nil {
		return nil
	}
	matches := inlineScriptRe.FindAllSubmatch(data, -1)
	hashes := make([]string, 0, len(matches))
	for _, m := range matches {
		sum := sha256.Sum256(m[1])
		hashes = append(hashes, fmt.Sprintf("'sha256-%s'", base64.StdEncoding.EncodeToString(sum[:])))
	}
	return hashes
}

// SecurityHeaders returns middleware that adds security-related HTTP response
// headers to every response. Pass the output of InlineScriptHashes as
// scriptHashes so the CSP allows the inline scripts injected by Vite.
// extraConnectSrc is called at most once per minute and its return value (if
// non-empty) is appended to the connect-src directive — use it to allow a
// dynamic direct-upload URL stored in the database.
// extraScriptAndFrameSrc is called at most once per minute and its return value
// (if non-empty) is appended to both script-src and frame-src — use it to allow
// a dynamic OnlyOffice Document Server URL.
type cachedCSPValue struct {
	value  string
	loaded time.Time
}
type cspValueCache struct {
	mu    sync.Mutex
	value cachedCSPValue
}

func (cache *cspValueCache) resolve(fn func() string) string {
	if fn == nil {
		return ""
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if time.Since(cache.value.loaded) < time.Minute {
		return cache.value.value
	}
	cache.value = cachedCSPValue{value: fn(), loaded: time.Now()}
	return cache.value.value
}

type securityHeadersConfig struct {
	staticScriptSrc, liveKitURL, appBaseURL string
	extraConnectSrc, extraScriptAndFrameSrc func() string
	connectCache, scriptFrameCache          cspValueCache
}

func SecurityHeaders(scriptHashes []string, extraConnectSrc func() string, extraScriptAndFrameSrc func() string, liveKitURL, appBaseURL string) func(http.Handler) http.Handler {
	config := securityHeadersConfig{
		staticScriptSrc: staticScriptSource(scriptHashes), liveKitURL: liveKitURL, appBaseURL: appBaseURL,
		extraConnectSrc: extraConnectSrc, extraScriptAndFrameSrc: extraScriptAndFrameSrc,
	}
	return config.middleware
}

func staticScriptSource(scriptHashes []string) string {
	base := "'self' https://static.cloudflareinsights.com https://cdn.jsdelivr.net"
	if len(scriptHashes) == 0 {
		return base
	}
	return base + " " + strings.Join(scriptHashes, " ")
}

func (config *securityHeadersConfig) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		headers := w.Header()
		setBaseSecurityHeaders(headers, request)
		headers.Set("Content-Security-Policy", config.contentSecurityPolicy())
		next.ServeHTTP(w, request)
	})
}

func (config *securityHeadersConfig) contentSecurityPolicy() string {
	connectSrc := appendCSPSource("'self' https://cloudflareinsights.com https://cdn.jsdelivr.net", websocketOrigin(config.appBaseURL))
	connectSrc = appendLiveKitConnectSources(connectSrc, config.liveKitURL)
	connectSrc = appendCSPSource(connectSrc, config.connectCache.resolve(config.extraConnectSrc))
	scriptSrc, frameSrc := config.scriptAndFrameSources()
	return "default-src 'self'; script-src " + scriptSrc + "; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob:; font-src 'self' data:; connect-src " + connectSrc + "; worker-src 'self' blob:; frame-src " + frameSrc + "; frame-ancestors 'none';"
}

func (config *securityHeadersConfig) scriptAndFrameSources() (string, string) {
	extra := config.scriptFrameCache.resolve(config.extraScriptAndFrameSrc)
	if extra == "" {
		return config.staticScriptSrc, "'none'"
	}
	return config.staticScriptSrc + " " + extra + " 'unsafe-inline'", extra
}

func appendCSPSource(value, source string) string {
	if source == "" {
		return value
	}
	return value + " " + source
}
func appendLiveKitConnectSources(value, liveKitURL string) string {
	parsed, err := url.Parse(liveKitURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "wss" && parsed.Scheme != "https") {
		return value
	}
	parsed.Path, parsed.RawQuery, parsed.Fragment = "", "", ""
	value = appendCSPSource(value, parsed.String())
	if parsed.Scheme == "wss" {
		parsed.Scheme = "https"
		value = appendCSPSource(value, parsed.String())
	}
	return value
}

func setBaseSecurityHeaders(headers http.Header, request *http.Request) {
	headers.Set("X-Content-Type-Options", "nosniff")
	headers.Set("X-Frame-Options", "DENY")
	headers.Set("Referrer-Policy", "strict-origin-when-cross-origin")
	// Sharedrive is a SPA/PWA: its document shell can be served from any route,
	// including `/`. Rooms requests microphone access only after an explicit user
	// action, while camera and screen capture remain prohibited everywhere.
	headers.Set("Permissions-Policy", "camera=(), microphone=(self), geolocation=(), payment=(), usb=(), display-capture=()")
	if request.TLS != nil || strings.EqualFold(request.Header.Get("X-Forwarded-Proto"), "https") {
		headers.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
	}
}

// websocketOrigin returns the concrete, same-origin WSS endpoint used by the
// Rooms chat. It avoids reopening the broad ws: or wss: CSP source schemes.
func websocketOrigin(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return ""
	}
	switch parsed.Scheme {
	case "https":
		parsed.Scheme = "wss"
	case "http":
		parsed.Scheme = "ws"
	default:
		return ""
	}
	parsed.Path = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}
