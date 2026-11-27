package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMailSuiteAllowsSameOriginEmbedding(t *testing.T) {
	handler := SecurityHeaders(nil, nil, func() string { return "https://office.example.test" }, "", "")(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))

	tests := []struct {
		path      string
		frame     string
		ancestors string
	}{
		{"/mail/suite-ui/?view=mail", "SAMEORIGIN", "'self'"},
		{"/files", "DENY", "'none'"},
		{"/mail", "DENY", "'none'"},
		{"/mail/suite-ui-other/", "DENY", "'none'"},
	}
	for _, test := range tests {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, test.path, nil))
		if got := w.Header().Get("X-Frame-Options"); got != test.frame {
			t.Errorf("%s: X-Frame-Options = %q, want %q", test.path, got, test.frame)
		}
		csp := w.Header().Get("Content-Security-Policy")
		if !strings.Contains(csp, "frame-ancestors "+test.ancestors+";") {
			t.Errorf("%s: unexpected frame-ancestors in %q", test.path, csp)
		}
		if !strings.Contains(csp, "frame-src 'self' https://office.example.test;") {
			t.Errorf("%s: same-origin frames or OnlyOffice missing in %q", test.path, csp)
		}
	}
}
