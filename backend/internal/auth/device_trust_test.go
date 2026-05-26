package auth

import "testing"

func TestUAFamilyMatch(t *testing.T) {
	tests := []struct {
		name    string
		stored  string
		current string
		want    bool
	}{
		{
			name:    "same Chrome browser",
			stored:  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			current: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
			want:    true,
		},
		{
			name:    "Chrome vs Firefox mismatch",
			stored:  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			current: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
			want:    false,
		},
		{
			name:    "Edge detected separately from Chrome",
			stored:  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
			current: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			want:    false,
		},
		{
			name:    "empty stored UA allowed",
			stored:  "",
			current: "Mozilla/5.0 Chrome/120.0",
			want:    false,
		},
		{
			name:    "empty current UA allowed",
			stored:  "Mozilla/5.0 Chrome/120.0",
			current: "",
			want:    false,
		},
		{
			name:    "both empty allowed",
			stored:  "",
			current: "",
			want:    true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := uaFamilyMatch(tt.stored, tt.current)
			if got != tt.want {
				t.Errorf("uaFamilyMatch() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestExtractUAFamily(t *testing.T) {
	tests := []struct {
		ua   string
		want string
	}{
		{"Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36 Edg/120.0", "edge"},
		{"Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36 OPR/106.0", "opera"},
		{"Mozilla/5.0 (rv:121.0) Gecko/20100101 Firefox/121.0", "firefox"},
		{"Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36", "chrome"},
		{"Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/17.0 Safari/605", "safari"},
		{"Mozilla/4.0 (compatible; MSIE 10.0)", "ie"},
		{"Mozilla/5.0 Trident/7.0", "ie"},
		{"curl/7.88.1", "unknown"},
	}

	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			got := extractUAFamily(tt.ua)
			if got != tt.want {
				t.Errorf("extractUAFamily(%q) = %q, want %q", tt.ua, got, tt.want)
			}
		})
	}
}

func TestCoarseIPMatch(t *testing.T) {
	tests := []struct {
		name string
		a, b string
		want bool
	}{
		{"same IPv4", "192.168.1.10", "192.168.1.20", true},
		{"same /16 different /24", "192.168.1.10", "192.168.2.20", true},
		{"different /16", "192.168.1.10", "10.0.1.10", false},
		{"same IPv6 /48", "2001:db8:1::1", "2001:db8:1::ffff", true},
		{"different IPv6 /48", "2001:db8:1::1", "2001:db8:2::1", false},
		{"empty a allows", "", "192.168.1.1", true},
		{"empty b allows", "192.168.1.1", "", true},
		{"both empty allows", "", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := coarseIPMatch(tt.a, tt.b)
			if got != tt.want {
				t.Errorf("coarseIPMatch(%q, %q) = %v, want %v", tt.a, tt.b, got, tt.want)
			}
		})
	}
}
