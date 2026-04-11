package backup

import "time"

// archiveVersion is embedded in manifest.json for future format migrations.
const archiveVersion = "1"

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
}
