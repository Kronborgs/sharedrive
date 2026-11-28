package admin

import (
	"bytes"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestValidateThemeImageRejectsActiveOrTruncatedUploads(t *testing.T) {
	var valid bytes.Buffer
	if err := png.Encode(&valid, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	mime, err := validateThemeImage(valid.Bytes())
	if err != nil || mime != "image/png" {
		t.Fatalf("valid PNG returned %q, %v", mime, err)
	}
	for name, data := range map[string][]byte{
		"active SVG": []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`),
		"truncated":  valid.Bytes()[:33],
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := validateThemeImage(data); err == nil {
				t.Fatal("invalid upload was accepted")
			}
		})
	}
}

func TestUpdateThemeColorsRejectsInvalidColors(t *testing.T) {
	h := &Handler{}
	for _, body := range []string{
		`{"accent":"red","background":"#010203","panel":"#040506"}`,
		`{"accent":"#010203","background":"#xyzxyz","panel":"#040506"}`,
		`{"accent":"#010203","background":"#040506","panel":""}`,
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(body))
		h.UpdateThemeAccent(recorder, request)
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("invalid colors %s: got %d, want 400", body, recorder.Code)
		}
	}
}