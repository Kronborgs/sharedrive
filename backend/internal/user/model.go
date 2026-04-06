package user

import (
	"time"

	"github.com/google/uuid"
)

// User represents an authenticated user in the system.
type User struct {
	ID                        uuid.UUID  `json:"id"`
	Email                     string     `json:"email"`
	DisplayName               string     `json:"display_name"`
	PasswordHash              string     `json:"-"` // never serialised
	Role                      string     `json:"role"`
	IsActive                  bool       `json:"is_active"`
	MustChangePassword        bool       `json:"must_change_password"`
	QuotaBytes                int64      `json:"quota_bytes"`
	QuotaUsedBytes            int64      `json:"quota_used_bytes"`
	BandwidthLimitBytesPerDay *int64     `json:"bandwidth_limit_bytes_per_day,omitempty"`
	WebDAVEnabled             bool       `json:"webdav_enabled"`
	TrashRetentionDays        *int       `json:"trash_retention_days,omitempty"`
	InvitedBy                 *uuid.UUID `json:"invited_by,omitempty"`
	LastLoginAt               *time.Time `json:"last_login_at,omitempty"`
	CreatedAt                 time.Time  `json:"created_at"`
	UpdatedAt                 time.Time  `json:"updated_at"`
}

// IsAdmin returns true when the user holds the admin role.
func (u *User) IsAdmin() bool {
	return u.Role == "admin"
}

// QuotaAvailableBytes returns how many bytes remain in the user's quota.
func (u *User) QuotaAvailableBytes() int64 {
	avail := u.QuotaBytes - u.QuotaUsedBytes
	if avail < 0 {
		return 0
	}
	return avail
}

// QuotaPercent returns quota usage as a 0–100 float.
func (u *User) QuotaPercent() float64 {
	if u.QuotaBytes == 0 {
		return 0
	}
	return float64(u.QuotaUsedBytes) / float64(u.QuotaBytes) * 100
}
