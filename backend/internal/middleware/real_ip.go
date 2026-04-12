package middleware

import (
	"net"
	"net/http"
	"strings"
	"sync"
)

// cloudflareIPHeader is the header Cloudflare sets with the real client IP.
const cloudflareIPHeader = "CF-Connecting-IP"

// trustedProxies holds the configured CIDR ranges whose proxy headers are trusted.
// When empty (default), NO proxy headers are honored — RemoteAddr is used as-is.
var (
	trustedProxies []*net.IPNet
	trustedMu      sync.RWMutex
)

// SetTrustedProxies configures the CIDR ranges that are allowed to set
// CF-Connecting-IP / X-Forwarded-For. Pass nil or empty to trust no proxies
// (RemoteAddr only). Called once at startup from config.
func SetTrustedProxies(cidrs []string) {
	trustedMu.Lock()
	defer trustedMu.Unlock()
	trustedProxies = nil
	for _, cidr := range cidrs {
		_, ipNet, err := net.ParseCIDR(cidr)
		if err != nil {
			// Try as bare IP → /32 or /128
			ip := net.ParseIP(cidr)
			if ip == nil {
				continue
			}
			bits := 32
			if ip.To4() == nil {
				bits = 128
			}
			ipNet = &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)}
		}
		trustedProxies = append(trustedProxies, ipNet)
	}
}

// isTrustedProxy reports whether the given IP (without port) belongs to a configured
// trusted proxy CIDR.
func isTrustedProxy(ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	trustedMu.RLock()
	defer trustedMu.RUnlock()
	for _, cidr := range trustedProxies {
		if cidr.Contains(ip) {
			return true
		}
	}
	return false
}

// stripPort removes the port suffix from an address (host:port → host).
func stripPort(addr string) string {
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return addr
}

// RealIP extracts the true client IP. It ONLY honors CF-Connecting-IP or
// X-Forwarded-For when the direct connection (RemoteAddr) comes from a
// configured trusted-proxy CIDR. Otherwise RemoteAddr is used as-is.
// This prevents IP spoofing by untrusted clients sending fake headers.
func RealIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		remoteIP := stripPort(r.RemoteAddr)

		if isTrustedProxy(remoteIP) {
			// Proxy is trusted — honor forwarded headers.
			if cfIP := r.Header.Get(cloudflareIPHeader); cfIP != "" {
				r.RemoteAddr = strings.TrimSpace(cfIP)
			} else if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
				// Take the rightmost entry added by the trusted proxy.
				// The leftmost entry is client-supplied and unverifiable.
				parts := strings.Split(xff, ",")
				r.RemoteAddr = strings.TrimSpace(parts[0])
			} else {
				r.RemoteAddr = remoteIP
			}
		} else {
			// Direct connection from non-trusted source — ignore all proxy headers.
			r.RemoteAddr = remoteIP
		}

		next.ServeHTTP(w, r)
	})
}

// ClientIP returns the client IP from the request, normalised by the RealIP
// middleware. Safe to call from any handler after RealIP has run.
func ClientIP(r *http.Request) string {
	return r.RemoteAddr
}
