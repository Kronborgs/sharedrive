package rooms

import (
	"testing"

	"github.com/google/uuid"
)

func TestUniqueConversationMembers(t *testing.T) {
	actorID := uuid.New()
	otherID := uuid.New()
	additionalID := uuid.New()

	members := uniqueConversationMembers(actorID, []uuid.UUID{actorID, otherID}, []uuid.UUID{otherID, additionalID, uuid.Nil})
	if len(members) != 3 {
		t.Fatalf("uniqueConversationMembers() returned %d members, want 3", len(members))
	}
	seen := make(map[uuid.UUID]bool, len(members))
	for _, memberID := range members {
		seen[memberID] = true
	}
	for _, expected := range []uuid.UUID{actorID, otherID, additionalID} {
		if !seen[expected] {
			t.Fatalf("uniqueConversationMembers() omitted %s", expected)
		}
	}
}
