package files

import "testing"

func TestParseUploadParentID(t *testing.T) {
	t.Parallel()

	const validID = "76d88f83-9529-4dae-b20a-13e5d4d85e5a"

	t.Run("root", func(t *testing.T) {
		parentID, err := parseUploadParentID("")
		if err != nil || parentID != nil {
			t.Fatalf("parseUploadParentID(root) = %v, %v; want nil, nil", parentID, err)
		}
	})

	t.Run("valid folder", func(t *testing.T) {
		parentID, err := parseUploadParentID(validID)
		if err != nil {
			t.Fatalf("parseUploadParentID(valid) returned error: %v", err)
		}
		if parentID == nil || parentID.String() != validID {
			t.Fatalf("parseUploadParentID(valid) = %v; want %s", parentID, validID)
		}
	})

	t.Run("invalid folder does not become root", func(t *testing.T) {
		parentID, err := parseUploadParentID("not-a-folder-id")
		if err == nil {
			t.Fatal("parseUploadParentID(invalid) returned nil error")
		}
		if parentID != nil {
			t.Fatalf("parseUploadParentID(invalid) = %v; want nil", parentID)
		}
	})
}
