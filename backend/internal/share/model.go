package share

import (
	"time"

	"github.com/google/uuid"
)

// GranteeType distinguishes between user and group share targets.
type GranteeType string

const (
	GranteeUser  GranteeType = "user"
	GranteeGroup GranteeType = "group"
)

// Share represents an access grant on a file or folder resource.
type Share struct {
	ID          uuid.UUID   `json:"id"`
	ResourceID  uuid.UUID   `json:"resource_id"`
	OwnerID     uuid.UUID   `json:"owner_id"`
	GranteeType GranteeType `json:"grantee_type"`
	GranteeID   uuid.UUID   `json:"grantee_id"`
	CanView     bool        `json:"can_view"`
	CanUpload   bool        `json:"can_upload"`
	CanEdit     bool        `json:"can_edit"`
	CanDelete   bool        `json:"can_delete"`
	CanReshare  bool        `json:"can_reshare"`
	CreatedBy   uuid.UUID   `json:"created_by"`
	ExpiresAt   *time.Time  `json:"expires_at,omitempty"`
	RevokedAt   *time.Time  `json:"revoked_at,omitempty"`
	CreatedAt   time.Time   `json:"created_at"`
}

// IsExpired returns true if the share has passed its expiry time.
func (s *Share) IsExpired() bool {
	return s.ExpiresAt != nil && time.Now().After(*s.ExpiresAt)
}

// IsActive returns true when the share is neither revoked nor expired.
func (s *Share) IsActive() bool {
	return s.RevokedAt == nil && !s.IsExpired()
}

// Permissions is the resolved effective permission set for an actor on a resource.
type Permissions struct {
	CanView    bool
	CanUpload  bool
	CanEdit    bool
	CanDelete  bool
	CanReshare bool
	IsOwner    bool
}

// HasAny returns true if the actor has at least view access.
func (p Permissions) HasAny() bool {
	return p.IsOwner || p.CanView
}
