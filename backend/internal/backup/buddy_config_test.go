package backup

import "testing"

func TestValidatePeerURL(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{"valid HTTPS", "https://backup.example.com", "https://backup.example.com", false},
		{"strips trailing slash", "https://backup.example.com/", "https://backup.example.com", false},
		{"strips multiple trailing slashes", "https://backup.example.com///", "https://backup.example.com", false},
		{"preserves path", "https://backup.example.com/api", "https://backup.example.com/api", false},
		{"trims whitespace", "  https://backup.example.com  ", "https://backup.example.com", false},

		{"rejects HTTP", "http://backup.example.com", "", true},
		{"rejects no scheme", "backup.example.com", "", true},
		{"rejects FTP", "ftp://backup.example.com", "", true},
		{"rejects localhost", "https://localhost", "", true},
		{"rejects 127.0.0.1", "https://127.0.0.1", "", true},
		{"rejects IPv6 loopback", "https://[::1]", "", true},
		{"rejects empty", "", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := validatePeerURL(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("validatePeerURL(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
				return
			}
			if !tt.wantErr && got != tt.want {
				t.Errorf("validatePeerURL(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
