package admin

import "testing"

func TestDirectUploadPublicSettings(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		rawURL       string
		wantURL      string
		wantEnabled  bool
		wantEndpoint string
	}{
		{name: "not configured", rawURL: "  ", wantURL: "", wantEnabled: false, wantEndpoint: ""},
		{name: "configured", rawURL: " https://upload.example.com/ ", wantURL: "https://upload.example.com/", wantEnabled: true, wantEndpoint: "https://upload.example.com/upload/"},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			gotURL, gotEnabled, gotEndpoint := directUploadPublicSettings(test.rawURL)
			if gotURL != test.wantURL || gotEnabled != test.wantEnabled || gotEndpoint != test.wantEndpoint {
				t.Fatalf("directUploadPublicSettings(%q) = (%q, %t, %q), want (%q, %t, %q)", test.rawURL, gotURL, gotEnabled, gotEndpoint, test.wantURL, test.wantEnabled, test.wantEndpoint)
			}
		})
	}
}
