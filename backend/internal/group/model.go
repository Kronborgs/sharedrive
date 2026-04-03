package group

import (
	"time"

	"github.com/google/uuid"
)

// Group represents a named collection of users for sharing purposes.
type Group struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	CreatedBy   uuid.UUID `json:"created_by"`
	CreatedAt   time.Time `json:"created_at"`
}

// Member represents a user's membership in a group.
type Member struct {
	GroupID uuid.UUID `json:"group_id"`
	UserID  uuid.UUID `json:"user_id"`
	AddedAt time.Time `json:"added_at"`
}
