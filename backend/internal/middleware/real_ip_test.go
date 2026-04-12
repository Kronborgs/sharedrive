package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// resetProxies clears the global trusted proxies list between tests.
func resetProxies() {
	trustedMu.Lock()
	trustedProxies = nil
	trustedMu.Unlock()
}

func TestRealIP_IgnoresHeadersWhenNoTrustedProxies(t *testing.T) {
	resetProxies()

	handler := RealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.RemoteAddr != "203.0.113.5" {
			t.Errorf("expected RemoteAddr=203.0.113.5, got %s", r.RemoteAddr)
		}
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "203.0.113.5:12345"
	req.Header.Set("CF-Connecting-IP", "198.51.100.1")
	req.Header.Set("X-Forwarded-For", "198.51.100.1")

	handler.ServeHTTP(httptest.NewRecorder(), req)
}

func TestRealIP_IgnoresHeadersFromUntrustedProxy(t *testing.T) {
	resetProxies()
	SetTrustedProxies([]string{"10.0.0.0/8"})
	defer resetProxies()

	handler := RealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.RemoteAddr != "203.0.113.5" {
			t.Errorf("expected RemoteAddr=203.0.113.5, got %s", r.RemoteAddr)
		}
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "203.0.113.5:12345" // not in 10.0.0.0/8
	req.Header.Set("CF-Connecting-IP", "198.51.100.1")

	handler.ServeHTTP(httptest.NewRecorder(), req)
}

func TestRealIP_HonorsCFHeaderFromTrustedProxy(t *testing.T) {
	resetProxies()
	SetTrustedProxies([]string{"10.0.0.0/8"})
	defer resetProxies()

	handler := RealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.RemoteAddr != "198.51.100.1" {
			t.Errorf("expected RemoteAddr=198.51.100.1, got %s", r.RemoteAddr)
		}
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.1:54321" // trusted proxy
	req.Header.Set("CF-Connecting-IP", "198.51.100.1")

	handler.ServeHTTP(httptest.NewRecorder(), req)
}

func TestRealIP_HonorsXFFFromTrustedProxy(t *testing.T) {
	resetProxies()
	SetTrustedProxies([]string{"172.16.0.0/12"})
	defer resetProxies()

	handler := RealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.RemoteAddr != "203.0.113.50" {
			t.Errorf("expected RemoteAddr=203.0.113.50, got %s", r.RemoteAddr)
		}
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "172.16.0.5:9999"
	req.Header.Set("X-Forwarded-For", "203.0.113.50, 172.16.0.5")

	handler.ServeHTTP(httptest.NewRecorder(), req)
}

func TestRealIP_CFHeaderTakesPrecedenceOverXFF(t *testing.T) {
	resetProxies()
	SetTrustedProxies([]string{"10.0.0.1/32"})
	defer resetProxies()

	handler := RealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.RemoteAddr != "1.2.3.4" {
			t.Errorf("expected RemoteAddr=1.2.3.4 (from CF), got %s", r.RemoteAddr)
		}
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "10.0.0.1:1111"
	req.Header.Set("CF-Connecting-IP", "1.2.3.4")
	req.Header.Set("X-Forwarded-For", "5.6.7.8")

	handler.ServeHTTP(httptest.NewRecorder(), req)
}

func TestSetTrustedProxies_BareIP(t *testing.T) {
	resetProxies()
	SetTrustedProxies([]string{"192.168.1.1"})
	defer resetProxies()

	if !isTrustedProxy("192.168.1.1") {
		t.Error("bare IP should be trusted")
	}
	if isTrustedProxy("192.168.1.2") {
		t.Error("different IP should not be trusted")
	}
}

func TestSetTrustedProxies_InvalidCIDRSkipped(t *testing.T) {
	resetProxies()
	SetTrustedProxies([]string{"not-a-cidr", "10.0.0.0/8"})
	defer resetProxies()

	if !isTrustedProxy("10.0.0.1") {
		t.Error("valid CIDR should still be loaded despite invalid entry")
	}
}

func TestIsTrustedProxy_EmptyList(t *testing.T) {
	resetProxies()

	if isTrustedProxy("10.0.0.1") {
		t.Error("should not trust any IP when list is empty")
	}
}
