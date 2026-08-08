package audit

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// Event type constants — these are stored verbatim in the audit_logs table.
const (
	// Auth events
	EventLoginSuccess           = "LOGIN_SUCCESS"
	EventLoginFailed            = "LOGIN_FAILED"
	EventLogout                 = "LOGOUT"
	EventTOTPEnabled            = "TOTP_ENABLED"
	EventTOTPDisabled           = "TOTP_DISABLED"
	EventPasswordChanged        = "PASSWORD_CHANGED"
	EventPasswordResetRequested = "PASSWORD_RESET_REQUESTED"
	EventPasswordResetConfirmed = "PASSWORD_RESET_CONFIRMED"
	EventSessionRevoked         = "SESSION_REVOKED"
	EventDeviceTrustGranted     = "DEVICE_TRUST_GRANTED"
	EventDeviceTrustRevoked     = "DEVICE_TRUST_REVOKED"

	// Rate limiting / lockout
	EventLockoutUser        = "LOCKOUT_USER"
	EventLockoutIP30M       = "LOCKOUT_IP_30M"
	EventLockoutIP60M       = "LOCKOUT_IP_60M"
	EventLockoutIP6H        = "LOCKOUT_IP_6H"
	EventLockoutIP24H       = "LOCKOUT_IP_24H"
	EventLockoutIPManual    = "LOCKOUT_IP_MANUAL"
	EventLockoutCleared     = "LOCKOUT_CLEARED_BY_ADMIN"
	EventIPWhitelisted      = "IP_WHITELISTED"
	EventIPWhitelistRemoved = "IP_WHITELIST_REMOVED"

	// File events
	EventFileUploaded         = "FILE_UPLOADED"
	EventFileDownloaded       = "FILE_DOWNLOADED"
	EventFileDeleted          = "FILE_DELETED"
	EventFileRestored         = "FILE_RESTORED"
	EventFilePermanentDeleted = "FILE_PERMANENTLY_DELETED"
	EventFileRenamed          = "FILE_RENAMED"
	EventFileMoved            = "FILE_MOVED"
	EventFolderCreated        = "FOLDER_CREATED"
	EventFilePreviewed        = "FILE_PREVIEWED"
	EventZipDownloaded        = "ZIP_DOWNLOADED"

	// Share events
	EventShareCreated  = "SHARE_CREATED"
	EventShareModified = "SHARE_MODIFIED"
	EventShareRevoked  = "SHARE_REVOKED"

	// Note events
	EventNoteCreated          = "NOTE_CREATED"
	EventNoteUpdated          = "NOTE_UPDATED"
	EventNoteDeleted          = "NOTE_DELETED"
	EventNoteRestored         = "NOTE_RESTORED"
	EventNotePermanentDeleted = "NOTE_PERMANENTLY_DELETED"
	EventNoteShareCreated     = "NOTE_SHARE_CREATED"
	EventNoteShareModified    = "NOTE_SHARE_MODIFIED"
	EventNoteShareRevoked     = "NOTE_SHARE_REVOKED"
	EventNoteGuestAccessed    = "NOTE_GUEST_ACCESSED"
	EventNoteGuestUpdated     = "NOTE_GUEST_UPDATED"
	EventNoteGuestSessionCreated = "NOTE_GUEST_SESSION_CREATED"

	// WebDAV events
	EventWebDAVLoginSuccess = "WEBDAV_LOGIN_SUCCESS"
	EventWebDAVLoginFailed  = "WEBDAV_LOGIN_FAILED"

	// Admin events
	EventAdminSupportStarted     = "ADMIN_SUPPORT_ACCESS_STARTED"
	EventAdminSupportEnded       = "ADMIN_SUPPORT_ACCESS_ENDED"
	EventUserCreated             = "USER_CREATED"
	EventUserDeleted             = "USER_DELETED"
	EventUserDeactivated         = "USER_DEACTIVATED"
	EventUserActivated           = "USER_ACTIVATED"
	EventUserForcedPasswordReset = "USER_FORCED_PASSWORD_RESET"
	EventUserQuotaChanged        = "USER_QUOTA_CHANGED"
	EventGroupCreated            = "GROUP_CREATED"
	EventGroupDeleted            = "GROUP_DELETED"
	EventSettingsChanged         = "SETTINGS_CHANGED"
	EventBackupExported          = "BACKUP_EXPORTED"
	EventBackupImported          = "BACKUP_IMPORTED"
	EventBackupRun               = "BACKUP_RUN"
	EventBackupRunAuto           = "BACKUP_RUN_AUTO"

	// WebDAV
	EventWebDAVAppPasswordCreated = "WEBDAV_APP_PASSWORD_CREATED"
	EventWebDAVAppPasswordRevoked = "WEBDAV_APP_PASSWORD_REVOKED"
	EventWebDAVFilePut            = "WEBDAV_FILE_PUT"
	EventWebDAVFileDelete         = "WEBDAV_FILE_DELETE"
)

// Aliases used by the auth handler — map to canonical event strings above.
const (
	EventUserLogin             = EventLoginSuccess
	EventUserLoginFailed       = EventLoginFailed
	EventUserLoginTOTPRequired = "LOGIN_TOTP_REQUIRED"
	EventUserLogout            = EventLogout
)

// Log is a persisted audit log record.
type Log struct {
	ID            uuid.UUID      `json:"id"`
	EventType     string         `json:"event_type"`
	ActorID       *uuid.UUID     `json:"actor_id,omitempty"`
	ActorEmail    string         `json:"actor_email,omitempty"`
	TargetUserID  *uuid.UUID     `json:"target_user_id,omitempty"`
	ResourceType  string         `json:"resource_type,omitempty"`
	ResourceID    *uuid.UUID     `json:"resource_id,omitempty"`
	ResourceName  string         `json:"resource_name,omitempty"`
	Metadata      map[string]any `json:"metadata,omitempty"`
	IPAddress     string         `json:"ip_address,omitempty"`
	UserAgent     string         `json:"user_agent,omitempty"`
	IsAdminAction bool           `json:"is_admin_action"`
	CreatedAt     time.Time      `json:"created_at"`
}

// Event is the input DTO used to emit an audit event.
type Event struct {
	Type          string
	ActorID       *uuid.UUID
	ActorEmail    string
	TargetUserID  *uuid.UUID
	ResourceType  string
	ResourceID    *uuid.UUID
	ResourceName  string
	Metadata      map[string]any
	IPAddress     string
	UserAgent     string
	IsAdminAction bool
}

// Logger is the interface audit consumers must implement.
// Implementations must be safe for concurrent use and must not block callers.
type Logger interface {
	Log(ctx context.Context, event Event)
}
