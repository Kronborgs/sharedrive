package middleware

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io/fs"
	"net/http"
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
func SecurityHeaders(scriptHashes []string, extraConnectSrc func() string) func(http.Handler) http.Handler {
	// Build the script-src directive once at startup
	scriptSrc := "'self' https://static.cloudflareinsights.com"
	if len(scriptHashes) > 0 {
		scriptSrc += " " + strings.Join(scriptHashes, " ")
	}

	// Cache extraConnectSrc result — the direct_upload_url changes rarely so
	// calling the DB query on every request is unnecessary overhead.
	var (
		cachedExtra string
		cachedAt    time.Time
		cacheMu     sync.Mutex
		cacheTTL    = 60 * time.Second
	)
	resolveExtra := func() string {
		if extraConnectSrc == nil {
			return ""
		}
		cacheMu.Lock()
		defer cacheMu.Unlock()
		if time.Since(cachedAt) < cacheTTL {
			return cachedExtra
		}
		cachedExtra = extraConnectSrc()
		cachedAt = time.Now()
		return cachedExtra
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			connectSrc := "'self' wss: ws: https://cloudflareinsights.com"
			if extra := resolveExtra(); extra != "" {
				connectSrc += " " + extra
			}
			csp := "default-src 'self'; " +
				"script-src " + scriptSrc + "; " +
				"style-src 'self' 'unsafe-inline'; " +
				"img-src 'self' data: blob:; " +
				"font-src 'self'; " +
				"connect-src " + connectSrc + "; " +
				"worker-src 'self' blob:; " +
				"frame-ancestors 'none';"

			h := w.Header()
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "DENY")
			h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
			h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
			h.Set("Content-Security-Policy", csp)
			// HSTS — only set over HTTPS connections
			if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
				h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
			}
			next.ServeHTTP(w, r)
		})
	}
}
