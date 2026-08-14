package admin

import (
	"reflect"
	"testing"
)

func TestPublicSettingsResponse(t *testing.T) {
	t.Parallel()

	kv := map[string]string{
		"direct_upload_url": " https://upload.example.com/ ",
		"onlyoffice_url":    "https://office.example.com",
	}
	want := map[string]any{
		"direct_upload_url":      "https://upload.example.com/",
		"direct_uploads_enabled": true,
		"upload_endpoint":        "https://upload.example.com/upload/",
		"onlyoffice_url":         "https://office.example.com",
		"playlist_max_tracks":    250,
		"rooms_enabled":          true,
	}

	if got := publicSettingsResponse(kv, 250, true); !reflect.DeepEqual(got, want) {
		t.Fatalf("publicSettingsResponse() = %#v, want %#v", got, want)
	}
}

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
