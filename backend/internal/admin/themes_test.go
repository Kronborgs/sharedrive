package admin

import (
	"bytes"
	"image"
	"image/png"
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
