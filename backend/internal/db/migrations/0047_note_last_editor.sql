-- +goose Up
DELETE FROM note_items WHERE btrim(content) = '';
ALTER TABLE notes ADD COLUMN last_edited_by TEXT;

-- +goose Down
ALTER TABLE notes DROP COLUMN IF EXISTS last_edited_by;
