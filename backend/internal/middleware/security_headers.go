package middleware

import (
	"net/http"
	"strings"
)

// SecurityHeaders adds security-related HTTP response headers to every response.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Content-Security-Policy",
			"default-src 'self'; "+
				// Allow Cloudflare Insights beacon (injected by Cloudflare tunnel/proxy)
				"script-src 'self' https://static.cloudflareinsights.com 'sha256-lha+JPoREIX1ySkzWVp1ml6GoP5RWj5Rr9XtE8ts59Q='; "+
				"style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: blob:; "+
				"font-src 'self'; "+
				"connect-src 'self' wss: ws: https://cloudflareinsights.com; "+
				"worker-src blob:; "+
				"frame-ancestors 'none';",
		)
		// HSTS — only set over HTTPS connections
		if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
			h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
		}
		next.ServeHTTP(w, r)
	})
}
