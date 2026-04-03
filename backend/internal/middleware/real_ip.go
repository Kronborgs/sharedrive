package middleware

import (
	"net"
	"net/http"
	"strings"
)

// cloudflareIPHeader is the header Cloudflare sets with the real client IP.
const cloudflareIPHeader = "CF-Connecting-IP"

// RealIP extracts the true client IP from Cloudflare's header (CF-Connecting-IP),
// falling back to X-Forwarded-For, then RemoteAddr. Sets r.RemoteAddr so
// downstream handlers see the correct IP uniformly.
func RealIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ip := r.Header.Get(cloudflareIPHeader); ip != "" {
			r.RemoteAddr = ip
		} else if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			// Take the first (leftmost) IP — the original client
			parts := strings.Split(xff, ",")
			if len(parts) > 0 {
				r.RemoteAddr = strings.TrimSpace(parts[0])
			}
		} else {
			// Strip port from RemoteAddr if present
			if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
				r.RemoteAddr = host
			}
		}
		next.ServeHTTP(w, r)
	})
}

// ClientIP returns the client IP from the request, normalised by the RealIP
// middleware. Safe to call from any handler after RealIP has run.
func ClientIP(r *http.Request) string {
	return r.RemoteAddr
}
