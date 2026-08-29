package rooms

import (
	"context"
	"strings"

	"github.com/google/uuid"
)

type GIFLibraryItem struct {
	ID          uuid.UUID `json:"id"`
	FileID      uuid.UUID `json:"file_id"`
	Title       string    `json:"title"`
	SearchTerms string    `json:"search_terms,omitempty"`
	Category    string    `json:"category,omitempty"`
	Name        string    `json:"name"`
	MimeType    string    `json:"mime_type"`
}

func isSupportedGIF(mimeType string) bool {
	mimeType = strings.ToLower(strings.TrimSpace(mimeType))
	return mimeType == "image/gif" || mimeType == "image/webp"
}

func (service *Service) ListGIFLibrary(ctx context.Context, actorID uuid.UUID, query string, limit int) ([]GIFLibraryItem, error) {
	if limit < 1 || limit > 48 {
		limit = 24
	}
	query = strings.TrimSpace(query)
	rows, err := service.db.Query(ctx, `SELECT library.id, library.file_id, library.title, library.search_terms, library.category, file.name, file.mime_type
        FROM room_gif_library library JOIN files file ON file.id=library.file_id
        WHERE file.deleted_at IS NULL AND ($1='' OR library.title ILIKE '%' || $1 || '%' OR library.search_terms ILIKE '%' || $1 || '%' OR library.category ILIKE '%' || $1 || '%')
        ORDER BY library.created_at DESC LIMIT $2`, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]GIFLibraryItem, 0)
	for rows.Next() {
		var item GIFLibraryItem
		if err := rows.Scan(&item.ID, &item.FileID, &item.Title, &item.SearchTerms, &item.Category, &item.Name, &item.MimeType); err != nil {
			return nil, err
		}
		if !isSupportedGIF(item.MimeType) {
			continue
		}
		if _, err := service.fileSvc.GetAccessible(ctx, item.FileID.String(), actorID.String()); err == nil {
			items = append(items, item)
		}
	}
	return items, rows.Err()
}

func (service *Service) ListAllGIFLibrary(ctx context.Context, query string, limit int) ([]GIFLibraryItem, error) {
	if limit < 1 || limit > 96 {
		limit = 48
	}
	query = strings.TrimSpace(query)
	rows, err := service.db.Query(ctx, `SELECT library.id, library.file_id, library.title, library.search_terms, library.category, file.name, file.mime_type
        FROM room_gif_library library JOIN files file ON file.id=library.file_id
        WHERE file.deleted_at IS NULL AND ($1='' OR library.title ILIKE '%' || $1 || '%' OR library.search_terms ILIKE '%' || $1 || '%' OR library.category ILIKE '%' || $1 || '%')
        ORDER BY library.created_at DESC LIMIT $2`, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]GIFLibraryItem, 0)
	for rows.Next() {
		var item GIFLibraryItem
		if err := rows.Scan(&item.ID, &item.FileID, &item.Title, &item.SearchTerms, &item.Category, &item.Name, &item.MimeType); err != nil {
			return nil, err
		}
		if isSupportedGIF(item.MimeType) {
			items = append(items, item)
		}
	}
	return items, rows.Err()
}

func (service *Service) AddGIFLibraryItem(ctx context.Context, actorID, fileID uuid.UUID, title, searchTerms, category string) (GIFLibraryItem, error) {
	file, err := service.fileSvc.GetAccessible(ctx, fileID.String(), actorID.String())
	if err != nil {
		return GIFLibraryItem{}, err
	}
	if !isSupportedGIF(file.MimeType) {
		return GIFLibraryItem{}, ErrForbidden
	}
	var item GIFLibraryItem
	err = service.db.QueryRow(ctx, `INSERT INTO room_gif_library(file_id,title,search_terms,category,created_by)
        VALUES($1,$2,$3,$4,$5) RETURNING id,file_id,title,search_terms,category`, fileID, strings.TrimSpace(title), strings.TrimSpace(searchTerms), strings.TrimSpace(category), actorID).
		Scan(&item.ID, &item.FileID, &item.Title, &item.SearchTerms, &item.Category)

	if err != nil {
		return GIFLibraryItem{}, err
	}
	item.Name, item.MimeType = file.Name, file.MimeType
	return item, nil
}

func (service *Service) RemoveGIFLibraryItem(ctx context.Context, id uuid.UUID) error {
	tag, err := service.db.Exec(ctx, `DELETE FROM room_gif_library WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
