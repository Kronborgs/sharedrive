package webdav

import (
	"time"

	"github.com/google/uuid"
)

// AppPassword represents a WebDAV-scoped credential for a user.
// The actual password is shown to the user once at creation time.
// Only the Argon2id hash is stored.
type AppPassword struct {
	ID            uuid.UUID  `json:"id"`
	UserID        uuid.UUID  `json:"user_id"`
	Name          string     `json:"name"`
	PasswordHash  string     `json:"-"` // never serialised
	Scope         string     `json:"scope"` // always "webdav"
	ResourceID    *uuid.UUID `json:"resource_id,omitempty"`   // nil = full tree access
	ResourceLabel string     `json:"resource_label,omitempty"` // display name
	LastUsedAt    *time.Time `json:"last_used_at,omitempty"`
	RevokedAt     *time.Time `json:"revoked_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
}

// IsActive returns true when the app password has not been revoked.
func (ap *AppPassword) IsActive() bool {
	return ap.RevokedAt == nil
}
