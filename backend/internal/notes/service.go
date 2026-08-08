package notes

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yourname/privatedrive/internal/audit"
)

type Service struct {
	db    *pgxpool.Pool
	audit audit.Logger
}

func NewService(db *pgxpool.Pool, auditLogger audit.Logger) *Service {
	return &Service{db: db, audit: auditLogger}
}

const noteColumns = `id, owner_id, type, title, content, color, is_pinned,
 is_archived, hide_completed, deleted_at, version, created_at, updated_at`

func scanNote(row pgx.Row) (Note, error) {
	var note Note
	err := row.Scan(&note.ID, &note.OwnerID, &note.Type, &note.Title, &note.Content, &note.Color,
		&note.IsPinned, &note.IsArchived, &note.HideCompleted, &note.DeletedAt, &note.Version,
		&note.CreatedAt, &note.UpdatedAt)
	return note, err
}

func (service *Service) List(ctx context.Context, ownerID uuid.UUID, options ListOptions) ([]Note, error) {
	if options.Limit < 1 || options.Limit > 100 {
		options.Limit = 50
	}
	if options.Offset < 0 {
		options.Offset = 0
	}
	search := normalizeSearch(options.Search)
	rows, err := service.db.Query(ctx, `SELECT `+noteColumns+`
		FROM notes n
		WHERE owner_id = $1
		  AND (($2 AND deleted_at IS NOT NULL) OR (NOT $2 AND deleted_at IS NULL))
		  AND ($2 OR is_archived = $3)
		  AND ($4 = '' OR type = $4)
		  AND ($5::boolean IS NULL OR is_pinned = $5)
		  AND ($6 = '' OR title ILIKE '%' || $6 || '%' OR content ILIKE '%' || $6 || '%'
		       OR EXISTS (SELECT 1 FROM note_items ni WHERE ni.note_id = n.id AND ni.content ILIKE '%' || $6 || '%'))
		ORDER BY is_pinned DESC, updated_at DESC
		LIMIT $7 OFFSET $8`, ownerID, options.Deleted, options.Archived, options.Type,
		options.Pinned, search, options.Limit, options.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	notes := make([]Note, 0)
	for rows.Next() {
		note, scanErr := scanNote(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		note.Items = []Item{}
		notes = append(notes, note)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	for index := range notes {
		if notes[index].Type != TypeChecklist {
			continue
		}
		notes[index].Items, err = service.listItems(ctx, notes[index].ID)
		if err != nil {
			return nil, err
		}
	}
	return notes, nil
}

func (service *Service) Get(ctx context.Context, ownerID, noteID uuid.UUID, includeDeleted bool) (Note, error) {
	note, err := scanNote(service.db.QueryRow(ctx, `SELECT `+noteColumns+`
		FROM notes WHERE id = $1 AND owner_id = $2 AND ($3 OR deleted_at IS NULL)`, noteID, ownerID, includeDeleted))
	if errors.Is(err, pgx.ErrNoRows) {
		return Note{}, ErrNotFound
	}
	if err != nil {
		return Note{}, err
	}
	note.Items, err = service.listItems(ctx, note.ID)
	return note, err
}

func (service *Service) listItems(ctx context.Context, noteID uuid.UUID) ([]Item, error) {
	rows, err := service.db.Query(ctx, `SELECT id, note_id, content, is_checked, position, created_at, updated_at
		FROM note_items WHERE note_id = $1 ORDER BY position, created_at`, noteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Item, 0)
	for rows.Next() {
		var item Item
		if err := rows.Scan(&item.ID, &item.NoteID, &item.Content, &item.IsChecked, &item.Position, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (service *Service) Create(ctx context.Context, ownerID uuid.UUID, input CreateInput) (Note, error) {
	if err := input.validate(); err != nil {
		return Note{}, err
	}
	tx, err := service.db.Begin(ctx)
	if err != nil {
		return Note{}, err
	}
	defer tx.Rollback(ctx)

	note, err := scanNote(tx.QueryRow(ctx, `INSERT INTO notes (owner_id, type, title, content, color)
		VALUES ($1, $2, $3, $4, $5) RETURNING `+noteColumns, ownerID, input.Type, input.Title, input.Content, input.Color))
	if err != nil {
		return Note{}, err
	}
	note.Items = make([]Item, 0, len(input.Items))
	for position, itemInput := range input.Items {
		var item Item
		err = tx.QueryRow(ctx, `INSERT INTO note_items (note_id, content, is_checked, position)
			VALUES ($1, $2, $3, $4)
			RETURNING id, note_id, content, is_checked, position, created_at, updated_at`,
			note.ID, itemInput.Content, itemInput.IsChecked, position).Scan(
			&item.ID, &item.NoteID, &item.Content, &item.IsChecked, &item.Position, &item.CreatedAt, &item.UpdatedAt)
		if err != nil {
			return Note{}, err
		}
		note.Items = append(note.Items, item)
	}
	if err := tx.Commit(ctx); err != nil {
		return Note{}, err
	}
	service.log(ownerID, note, audit.EventNoteCreated)
	return note, nil
}

func (service *Service) Update(ctx context.Context, ownerID, noteID uuid.UUID, input UpdateInput) (Note, error) {
	if err := input.validate(); err != nil {
		return Note{}, err
	}
	color := input.Color
	clearColor := input.ClearColor
	note, err := scanNote(service.db.QueryRow(ctx, `UPDATE notes SET
		title = COALESCE($4, title), content = COALESCE($5, content),
		color = CASE WHEN $6 THEN NULL ELSE COALESCE($7, color) END,
		is_pinned = COALESCE($8, is_pinned), is_archived = COALESCE($9, is_archived),
		hide_completed = COALESCE($10, hide_completed), version = version + 1, updated_at = NOW()
		WHERE id = $1 AND owner_id = $2 AND version = $3 AND deleted_at IS NULL
		RETURNING `+noteColumns, noteID, ownerID, input.Version, input.Title, input.Content,
		clearColor, color, input.IsPinned, input.IsArchived, input.HideCompleted))
	if errors.Is(err, pgx.ErrNoRows) {
		return Note{}, service.mutationError(ctx, ownerID, noteID)
	}
	if err != nil {
		return Note{}, err
	}
	note.Items, err = service.listItems(ctx, note.ID)
	if err == nil {
		service.log(ownerID, note, audit.EventNoteUpdated)
	}
	return note, err
}

func (service *Service) SoftDelete(ctx context.Context, ownerID, noteID uuid.UUID) error {
	tag, err := service.db.Exec(ctx, `UPDATE notes SET deleted_at = NOW(), version = version + 1, updated_at = NOW()
		WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`, noteID, ownerID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	service.logID(ownerID, noteID, audit.EventNoteDeleted)
	return nil
}

func (service *Service) Restore(ctx context.Context, ownerID, noteID uuid.UUID) error {
	tag, err := service.db.Exec(ctx, `UPDATE notes SET deleted_at = NULL, version = version + 1, updated_at = NOW()
		WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL`, noteID, ownerID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	service.logID(ownerID, noteID, audit.EventNoteRestored)
	return nil
}

func (service *Service) PermanentDelete(ctx context.Context, ownerID, noteID uuid.UUID) error {
	tag, err := service.db.Exec(ctx, `DELETE FROM notes WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL`, noteID, ownerID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	service.logID(ownerID, noteID, audit.EventNotePermanentDeleted)
	return nil
}

func (service *Service) CreateItem(ctx context.Context, ownerID, noteID uuid.UUID, input ItemInput) (Note, error) {
	if input.Version < 1 || input.Content == nil || len([]rune(*input.Content)) > MaxItemLength {
		return Note{}, ErrInvalid
	}
	return service.mutateItems(ctx, ownerID, noteID, input.Version, func(tx pgx.Tx) error {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM note_items WHERE note_id = $1`, noteID).Scan(&count); err != nil {
			return err
		}
		if count >= MaxItems {
			return ErrInvalid
		}
		position := count
		if input.Position != nil && *input.Position >= 0 && *input.Position <= count {
			position = *input.Position
			if _, err := tx.Exec(ctx, `UPDATE note_items SET position = position + 1 WHERE note_id = $1 AND position >= $2`, noteID, position); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `INSERT INTO note_items (note_id, content, is_checked, position)
			VALUES ($1, $2, COALESCE($3, FALSE), $4)`, noteID, *input.Content, input.IsChecked, position)
		return err
	})
}

func (service *Service) UpdateItem(ctx context.Context, ownerID, noteID, itemID uuid.UUID, input ItemInput) (Note, error) {
	if input.Version < 1 || input.Content != nil && len([]rune(*input.Content)) > MaxItemLength {
		return Note{}, ErrInvalid
	}
	return service.mutateItems(ctx, ownerID, noteID, input.Version, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE note_items SET content = COALESCE($3, content),
			is_checked = COALESCE($4, is_checked), updated_at = NOW()
			WHERE id = $1 AND note_id = $2`, itemID, noteID, input.Content, input.IsChecked)
		if err == nil && tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return err
	})
}

func (service *Service) DeleteItem(ctx context.Context, ownerID, noteID, itemID uuid.UUID, version int64) (Note, error) {
	if version < 1 {
		return Note{}, ErrInvalid
	}
	return service.mutateItems(ctx, ownerID, noteID, version, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM note_items WHERE id = $1 AND note_id = $2`, itemID, noteID)
		if err == nil && tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return err
	})
}

func (service *Service) ReorderItems(ctx context.Context, ownerID, noteID uuid.UUID, input ReorderInput) (Note, error) {
	if input.Version < 1 || len(input.ItemIDs) > MaxItems {
		return Note{}, ErrInvalid
	}
	seen := make(map[uuid.UUID]struct{}, len(input.ItemIDs))
	for _, itemID := range input.ItemIDs {
		if _, exists := seen[itemID]; exists {
			return Note{}, ErrInvalid
		}
		seen[itemID] = struct{}{}
	}
	return service.mutateItems(ctx, ownerID, noteID, input.Version, func(tx pgx.Tx) error {
		var count int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM note_items WHERE note_id = $1`, noteID).Scan(&count); err != nil {
			return err
		}
		if count != len(input.ItemIDs) {
			return ErrInvalid
		}
		for position, itemID := range input.ItemIDs {
			tag, err := tx.Exec(ctx, `UPDATE note_items SET position = $3, updated_at = NOW()
				WHERE id = $1 AND note_id = $2`, itemID, noteID, position)
			if err != nil || tag.RowsAffected() == 0 {
				return ErrInvalid
			}
		}
		return nil
	})
}

func (service *Service) mutateItems(ctx context.Context, ownerID, noteID uuid.UUID, version int64, mutation func(pgx.Tx) error) (Note, error) {
	tx, err := service.db.Begin(ctx)
	if err != nil {
		return Note{}, err
	}
	defer tx.Rollback(ctx)
	var currentVersion int64
	err = tx.QueryRow(ctx, `SELECT version FROM notes
		WHERE id = $1 AND owner_id = $2 AND type = 'checklist' AND deleted_at IS NULL FOR UPDATE`, noteID, ownerID).Scan(&currentVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return Note{}, ErrNotFound
	}
	if err != nil {
		return Note{}, err
	}
	if currentVersion != version {
		return Note{}, ErrConflict
	}
	if err := mutation(tx); err != nil {
		return Note{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE notes SET version = version + 1, updated_at = NOW() WHERE id = $1`, noteID); err != nil {
		return Note{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Note{}, err
	}
	note, err := service.Get(ctx, ownerID, noteID, false)
	if err == nil {
		service.log(ownerID, note, audit.EventNoteUpdated)
	}
	return note, err
}

func (service *Service) mutationError(ctx context.Context, ownerID, noteID uuid.UUID) error {
	var exists bool
	err := service.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM notes WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL)`, noteID, ownerID).Scan(&exists)
	if err != nil {
		return err
	}
	if exists {
		return ErrConflict
	}
	return ErrNotFound
}

func (service *Service) log(actorID uuid.UUID, note Note, eventType string) {
	if service.audit == nil {
		return
	}
	service.audit.Log(context.Background(), audit.Event{Type: eventType, ActorID: &actorID,
		ResourceType: "note", ResourceID: &note.ID, ResourceName: note.Title})
}

func (service *Service) logID(actorID, noteID uuid.UUID, eventType string) {
	if service.audit == nil {
		return
	}
	service.audit.Log(context.Background(), audit.Event{Type: eventType, ActorID: &actorID,
		ResourceType: "note", ResourceID: &noteID, Metadata: map[string]any{"source": "notes"}})
}

func PublicError(err error) (int, string) {
	switch {
	case errors.Is(err, ErrInvalid):
		return 400, "invalid note data"
	case errors.Is(err, ErrNotFound):
		return 404, "note not found"
	case errors.Is(err, ErrConflict):
		return 409, "note version conflict"
	default:
		return 500, fmt.Sprint("internal error")
	}
}