package backup

import "time"

// archiveVersion is embedded in manifest.json for future format migrations.
const archiveVersion = "3"

// archiveManifest is the first JSON entry in every .shdbak archive.
type archiveManifest struct {
	Version     string    `json:"version"`
	UserID      string    `json:"user_id"`
	CreatedAt   time.Time `json:"created_at"`
	FileCount   int       `json:"file_count"`
	FolderCount int       `json:"folder_count"`
}

// archiveFileRecord mirrors the files table columns stored in metadata.json.
type archiveFileRecord struct {
	ID             string     `json:"id"`
	ParentID       *string    `json:"parent_id"`
	OwnerID        string     `json:"owner_id"`
	IsFolder       bool       `json:"is_folder"`
	Name           string     `json:"name"`
	MimeType       string     `json:"mime_type,omitempty"`
	SizeBytes      int64      `json:"size_bytes"`
	ChecksumSHA256 *string    `json:"checksum_sha256,omitempty"`
	DeletedAt      *time.Time `json:"deleted_at,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
	ArchivePath    string     `json:"archive_path,omitempty"`
}

type archiveNoteRecord struct {
	ID            string              `json:"id"`
	Type          string              `json:"type"`
	Title         string              `json:"title"`
	Content       string              `json:"content"`
	Color         *string             `json:"color,omitempty"`
	IsPinned      bool                `json:"is_pinned"`
	IsArchived    bool                `json:"is_archived"`
	HideCompleted bool                `json:"hide_completed"`
	DeletedAt     *time.Time          `json:"deleted_at,omitempty"`
	Version       int64               `json:"version"`
	CreatedAt     time.Time           `json:"created_at"`
	UpdatedAt     time.Time           `json:"updated_at"`
	Items         []archiveNoteItem   `json:"items"`
	Shares        []archiveNoteShare  `json:"shares"`
}

type archiveNoteItem struct {
	ID        string    `json:"id"`
	Content   string    `json:"content"`
	IsChecked bool      `json:"is_checked"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type archiveNoteShare struct {
	ID                  string     `json:"id"`
	RecipientEmail      string     `json:"recipient_email"`
	Permission          string     `json:"permission"`
	InvitationTokenHash string     `json:"invitation_token_hash"`
	ExpiresAt           *time.Time `json:"expires_at,omitempty"`
	RevokedAt           *time.Time `json:"revoked_at,omitempty"`
	LastSentAt          *time.Time `json:"last_sent_at,omitempty"`
	LastOpenedAt        *time.Time `json:"last_opened_at,omitempty"`
	CreatedAt           time.Time  `json:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
}
