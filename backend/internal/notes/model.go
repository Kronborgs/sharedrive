package notes

import (
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	TypeText      = "text"
	TypeChecklist = "checklist"

	MaxTitleLength   = 300
	MaxContentLength = 100000
	MaxItemLength    = 2000
	MaxItems         = 500
)

var (
	ErrNotFound = errors.New("note not found")
	ErrConflict = errors.New("note version conflict")
	ErrInvalid  = errors.New("invalid note")
)

type Note struct {
	ID            uuid.UUID  `json:"id"`
	OwnerID       uuid.UUID  `json:"owner_id"`
	Type          string     `json:"type"`
	Title         string     `json:"title"`
	Content       string     `json:"content"`
	Color         *string    `json:"color,omitempty"`
	IsPinned      bool       `json:"is_pinned"`
	IsArchived    bool       `json:"is_archived"`
	HideCompleted bool       `json:"hide_completed"`
	DeletedAt     *time.Time `json:"deleted_at,omitempty"`
	Version       int64      `json:"version"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	Items         []Item     `json:"items"`
}

type Item struct {
	ID        uuid.UUID `json:"id"`
	NoteID    uuid.UUID `json:"note_id"`
	Content   string    `json:"content"`
	IsChecked bool      `json:"is_checked"`
	Position  int       `json:"position"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type CreateInput struct {
	Type    string            `json:"type"`
	Title   string            `json:"title"`
	Content string            `json:"content"`
	Color   *string           `json:"color"`
	Items   []CreateItemInput `json:"items"`
}

type CreateItemInput struct {
	Content   string `json:"content"`
	IsChecked bool   `json:"is_checked"`
}

type UpdateInput struct {
	Version       int64   `json:"version"`
	Title         *string `json:"title"`
	Content       *string `json:"content"`
	Color         *string `json:"color"`
	ClearColor    bool    `json:"clear_color"`
	IsPinned      *bool   `json:"is_pinned"`
	IsArchived    *bool   `json:"is_archived"`
	HideCompleted *bool   `json:"hide_completed"`
}

type ItemInput struct {
	Version   int64   `json:"version"`
	Content   *string `json:"content"`
	IsChecked *bool   `json:"is_checked"`
	Position  *int    `json:"position"`
}

type ReorderInput struct {
	Version int64       `json:"version"`
	ItemIDs []uuid.UUID `json:"item_ids"`
}

type ListOptions struct {
	Search   string
	Type     string
	Archived bool
	Deleted  bool
	Pinned   *bool
	Limit    int
	Offset   int
}

func (input CreateInput) validate() error {
	if input.Type != TypeText && input.Type != TypeChecklist {
		return ErrInvalid
	}
	if len([]rune(input.Title)) > MaxTitleLength || len([]rune(input.Content)) > MaxContentLength {
		return ErrInvalid
	}
	if input.Type == TypeText && len(input.Items) > 0 || len(input.Items) > MaxItems {
		return ErrInvalid
	}
	for _, item := range input.Items {
		if len([]rune(item.Content)) > MaxItemLength {
			return ErrInvalid
		}
	}
	return nil
}

func (input UpdateInput) validate() error {
	if input.Version < 1 {
		return ErrInvalid
	}
	if input.Title != nil && len([]rune(*input.Title)) > MaxTitleLength {
		return ErrInvalid
	}
	if input.Content != nil && len([]rune(*input.Content)) > MaxContentLength {
		return ErrInvalid
	}
	return nil
}

func normalizeSearch(value string) string {
	return strings.TrimSpace(value)
}