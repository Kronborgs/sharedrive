package server

import "testing"

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
