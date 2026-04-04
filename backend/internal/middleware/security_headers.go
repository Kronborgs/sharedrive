package middleware

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
)

// inlineScriptRe matches the content of <script> tags that contain inline code.
// External scripts (<script src="..."></script>) have empty bodies and won't be
// captured because `[^<]+` requires at least one non-`<` byte.
// Vite injects a modulepreload polyfill as an inline script whose content changes
// with every build, so we compute hashes at startup rather than hardcoding them.
var inlineScriptRe = regexp.MustCompile(`(?s)<script[^>]*>([^<]+)</script>`)

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
func SecurityHeaders(scriptHashes []string) func(http.Handler) http.Handler {
	// Build the script-src directive once at startup
	scriptSrc := "'self' https://static.cloudflareinsights.com"
	if len(scriptHashes) > 0 {
		scriptSrc += " " + strings.Join(scriptHashes, " ")
	}
	csp := "default-src 'self'; " +
		"script-src " + scriptSrc + "; " +
		"style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: blob:; " +
		"font-src 'self'; " +
		"connect-src 'self' wss: ws: https://cloudflareinsights.com; " +
		"worker-src blob:; " +
		"frame-ancestors 'none';"

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

