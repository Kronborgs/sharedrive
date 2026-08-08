package notes

import (
	"strings"
	"testing"
)

func TestCreateInputValidation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input CreateInput
		valid bool
	}{
		{name: "text", input: CreateInput{Type: TypeText, Title: "Title", Content: "Body"}, valid: true},
		{name: "checklist", input: CreateInput{Type: TypeChecklist, Items: []CreateItemInput{{Content: "Item"}}}, valid: true},
		{name: "unknown type", input: CreateInput{Type: "html"}},
		{name: "text with items", input: CreateInput{Type: TypeText, Items: []CreateItemInput{{Content: "Item"}}}},
		{name: "title too long", input: CreateInput{Type: TypeText, Title: strings.Repeat("x", MaxTitleLength+1)}},
		{name: "item too long", input: CreateInput{Type: TypeChecklist, Items: []CreateItemInput{{Content: strings.Repeat("x", MaxItemLength+1)}}}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.input.validate()
			if test.valid && err != nil {
				t.Fatalf("validate() returned %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("validate() returned nil")
			}
		})
	}
}

func TestSecureTokenUsesRandom256BitValueAndSHA256Hash(t *testing.T) {
	t.Parallel()

	rawOne, hashOne, err := secureToken()
	if err != nil {
		t.Fatal(err)
	}
	rawTwo, hashTwo, err := secureToken()
	if err != nil {
		t.Fatal(err)
	}
	if rawOne == rawTwo || hashOne == hashTwo {
		t.Fatal("secureToken returned duplicate values")
	}
	if len(hashOne) != 64 || tokenHash(rawOne) != hashOne {
		t.Fatalf("unexpected SHA-256 hash %q", hashOne)
	}
	if strings.Contains(hashOne, rawOne) {
		t.Fatal("stored hash contains raw token")
	}
}

func TestNormalizeEmail(t *testing.T) {
	t.Parallel()

	email, err := normalizeEmail("  Guest@Example.COM ")
	if err != nil || email != "guest@example.com" {
		t.Fatalf("normalizeEmail() = %q, %v", email, err)
	}
	if _, err := normalizeEmail("not-an-email"); err == nil {
		t.Fatal("normalizeEmail accepted invalid email")
	}
}

func TestValidPermission(t *testing.T) {
	t.Parallel()
	for _, permission := range []string{"view", "check", "edit"} {
		if !validPermission(permission) {
			t.Fatalf("permission %q was rejected", permission)
		}
	}
	if validPermission("manage") {
		t.Fatal("manage permission was accepted")
	}
}