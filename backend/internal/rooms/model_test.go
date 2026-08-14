package rooms

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestRoomJSONHidesManagedGroupID(t *testing.T) {
	t.Parallel()

	encoded, err := json.Marshal(Room{ManagedGroupID: uuid.MustParse("00000000-0000-0000-0000-000000000001")})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "managed_group") {
		t.Fatalf("Room JSON exposed managed group id: %s", encoded)
	}
}

func TestNormalizeName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		input   string
		want    string
		wantErr error
	}{
		{name: "trims surrounding whitespace", input: "  Project Alpha  ", want: "Project Alpha"},
		{name: "accepts maximum length", input: strings.Repeat("a", maxRoomNameRunes), want: strings.Repeat("a", maxRoomNameRunes)},
		{name: "rejects empty", input: "  ", wantErr: ErrInvalidName},
		{name: "rejects too long", input: strings.Repeat("a", maxRoomNameRunes+1), wantErr: ErrInvalidName},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got, err := NormalizeName(test.input)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("NormalizeName() error = %v, want %v", err, test.wantErr)
			}
			if got != test.want {
				t.Fatalf("NormalizeName() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestSlugify(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "simple name", input: "Project Alpha", want: "project-alpha"},
		{name: "Danish letters", input: "Møde på Øen", want: "moede-paa-oeen"},
		{name: "emits ASCII only", input: "Café 42", want: "caf-42"},
		{name: "collapses punctuation", input: "  Kunde --- Jensen!  ", want: "kunde-jensen"},
		{name: "fallback", input: "日本語", want: "room"},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := Slugify(test.input); got != test.want {
				t.Fatalf("Slugify(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}

func TestValidRole(t *testing.T) {
	t.Parallel()

	for _, role := range []string{RoleOwner, RoleModerator, RoleMember} {
		if !ValidRole(role) {
			t.Fatalf("ValidRole(%q) = false", role)
		}
	}
	for _, role := range []string{"", "admin", "guest"} {
		if ValidRole(role) {
			t.Fatalf("ValidRole(%q) = true", role)
		}
	}
}
