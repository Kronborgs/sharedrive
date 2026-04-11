package backup

import "time"

// BackupPasswordStatus is returned by GET /api/v1/backup/password.
// It describes whether the user has an active backup password and when it was
// last used, without exposing any secret material.
type BackupPasswordStatus struct {
	HasPassword bool       `json:"has_password"`
	ID          *string    `json:"id,omitempty"`
	LastUsedAt  *time.Time `json:"last_used_at,omitempty"`
	CreatedAt   *time.Time `json:"created_at,omitempty"`
}

// generatePasswordResponse is returned once on POST /api/v1/backup/password.
// The token is the raw 32-byte hex that the user must save immediately.
type generatePasswordResponse struct {
	ID    string `json:"id"`
	Token string `json:"token"` // shown exactly once — the raw backup token
}

// restoreResult summarises what a restore operation imported.
type restoreResult struct {
	FilesRestored   int   `json:"files_restored"`
	FoldersRestored int   `json:"folders_restored"`
	BytesRestored   int64 `json:"bytes_restored"`
	Skipped         int   `json:"skipped"`
}
