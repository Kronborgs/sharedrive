package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestFrontendServesNestedMailApp(t *testing.T) {
	t.Parallel()

	frontend := frontendHandler(fstest.MapFS{
		"index.html":                {Data: []byte("Sharedrive")},
		"mail/suite-ui/index.html":  {Data: []byte("Sharedrive Mail")},
		"mail/suite-ui/assets/a.js": {Data: []byte("mail JavaScript")},
	})
	tests := []struct {
		path string
		want string
	}{
		{"/mail/suite-ui/?view=mail", "Sharedrive Mail"},
		{"/mail/suite-ui/assets/a.js", "mail JavaScript"},
		{"/mail", "Sharedrive"},
		{"/mail/", "Sharedrive"},
	}
	for _, tc := range tests {
		response := httptest.NewRecorder()
		frontend.ServeHTTP(response, httptest.NewRequest(http.MethodGet, tc.path, nil))
		if response.Code != http.StatusOK || response.Body.String() != tc.want {
			t.Errorf("GET %s: got %d %q, want %d %q", tc.path, response.Code, response.Body.String(), http.StatusOK, tc.want)
		}
	}
}

func TestShouldApplyGlobalBodyLimit(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		path   string
		method string
		want   bool
	}{
		{name: "JSON API", path: "/api/v1/notes", method: http.MethodPost, want: true},
		{name: "multipart upload", path: filesUploadRoute, method: http.MethodPost, want: false},
		{name: "theme upload", path: "/api/v1/admin/themes", method: http.MethodPost, want: false},
		{name: "theme other method", path: "/api/v1/admin/themes", method: http.MethodPut, want: true},
		{name: "TUS upload", path: "/upload/123", method: http.MethodPatch, want: false},
		{name: "buddy receive", path: "/api/v1/backup/buddy/receive", method: http.MethodPost, want: false},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := shouldApplyGlobalBodyLimit(test.path, test.method); got != test.want {
				t.Fatalf("shouldApplyGlobalBodyLimit(%q, %q) = %t, want %t", test.path, test.method, got, test.want)
			}
		})
	}
}

func TestTusFolderID(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		meta map[string]string
		want string
	}{
		{
			name: "current folder_id metadata",
			meta: map[string]string{"folder_id": "folder-current"},
			want: "folder-current",
		},
		{
			name: "legacy parent_id metadata",
			meta: map[string]string{"parent_id": "folder-legacy"},
			want: "folder-legacy",
		},
		{
			name: "current metadata takes precedence",
			meta: map[string]string{
				"folder_id": "folder-current",
				"parent_id": "folder-legacy",
			},
			want: "folder-current",
		},
		{
			name: "root folder",
			meta: map[string]string{},
			want: "",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := tusFolderID(tt.meta); got != tt.want {
				t.Fatalf("tusFolderID() = %q, want %q", got, tt.want)
			}
		})
	}
}
