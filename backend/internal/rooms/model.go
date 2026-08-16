package rooms

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	RoleOwner     = "owner"
	RoleModerator = "moderator"
	RoleMember    = "member"

	maxRoomNameRunes = 120
)

var (
	ErrInvalidName    = errors.New("room name must be between 1 and 120 characters")
	ErrInvalidRole    = errors.New("invalid room role")
	ErrInvalidMessage = errors.New("message must be between 1 and 4000 characters")
)

type Room struct {
	ID             uuid.UUID  `json:"id"`
	Name           string     `json:"name"`
	Slug           string     `json:"slug"`
	OwnerID        uuid.UUID  `json:"owner_id"`
	ManagedGroupID uuid.UUID  `json:"-"`
	CreatedBy      *uuid.UUID `json:"created_by,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
	ArchivedAt     *time.Time `json:"archived_at,omitempty"`
	CurrentRole    string     `json:"current_role"`
}

type Member struct {
	RoomID      uuid.UUID  `json:"room_id"`
	UserID      uuid.UUID  `json:"user_id"`
	Role        string     `json:"role"`
	DisplayName string     `json:"display_name"`
	Email       string     `json:"email"`
	JoinedAt    time.Time  `json:"joined_at"`
	AddedBy     *uuid.UUID `json:"added_by,omitempty"`
}

func NormalizeName(name string) (string, error) {
	normalized := strings.TrimSpace(name)
	if normalized == "" || utf8.RuneCountInString(normalized) > maxRoomNameRunes {
		return "", ErrInvalidName
	}
	return normalized, nil
}

func ValidRole(role string) bool {
	switch role {
	case RoleOwner, RoleModerator, RoleMember:
		return true
	default:
		return false
	}
}

func Slugify(name string) string {
	var slug strings.Builder
	separatorPending := false
	writeToken := func(token string) {
		if separatorPending && slug.Len() > 0 {
			slug.WriteByte('-')
		}
		slug.WriteString(token)
		separatorPending = false
	}

	for _, raw := range strings.ToLower(strings.TrimSpace(name)) {
		switch raw {
		case 'æ':
			writeToken("ae")
		case 'ø':
			writeToken("oe")
		case 'å':
			writeToken("aa")
		default:
			if raw >= 'a' && raw <= 'z' || raw >= '0' && raw <= '9' {
				writeToken(string(raw))
			} else if slug.Len() > 0 {
				separatorPending = true
			}
		}
	}

	value := strings.TrimRight(slug.String(), "-")
	if value == "" {
		return "room"
	}
	return value
}

type Message struct {
	ID                   uuid.UUID  `json:"id"`
	RoomID               uuid.UUID  `json:"room_id"`
	SenderUserID         *uuid.UUID `json:"sender_user_id,omitempty"`
	SenderGuestSessionID *uuid.UUID `json:"sender_guest_session_id,omitempty"`
	SenderName           string     `json:"sender_name"`
	Body                 string     `json:"body"`
	ReplyToMessageID     *uuid.UUID `json:"reply_to_message_id,omitempty"`
	CreatedAt            time.Time  `json:"created_at"`
	EditedAt             *time.Time `json:"edited_at,omitempty"`
	DeletedAt            *time.Time `json:"deleted_at,omitempty"`
	Reactions            []Reaction `json:"reactions"`
}

type Reaction struct {
	UserID         *uuid.UUID `json:"user_id,omitempty"`
	GuestSessionID *uuid.UUID `json:"guest_session_id,omitempty"`
	Emoji          string     `json:"emoji"`
	DisplayName    string     `json:"display_name"`
}
type MessagePage struct {
	Messages   []Message `json:"messages"`
	NextCursor string    `json:"next_cursor,omitempty"`
}

func NormalizeMessage(body string, maxRunes int) (string, error) {
	normalized := strings.TrimSpace(body)
	if normalized == "" || utf8.RuneCountInString(normalized) > maxRunes {
		return "", ErrInvalidMessage
	}
	return normalized, nil
}

type ResourceType string

const (
	ResourceFile ResourceType = "file"
	ResourceNote ResourceType = "note"
)

type Resource struct {
	ID           uuid.UUID    `json:"id"`
	RoomID       uuid.UUID    `json:"room_id"`
	ResourceType ResourceType `json:"resource_type"`
	ResourceID   uuid.UUID    `json:"resource_id"`
	AddedBy      *uuid.UUID   `json:"added_by,omitempty"`
	CreatedAt    time.Time    `json:"created_at"`
}

func ValidResourceType(resourceType ResourceType) bool {
	return resourceType == ResourceFile || resourceType == ResourceNote
}
