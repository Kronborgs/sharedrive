-- +goose Up
ALTER TABLE groups ADD COLUMN color TEXT NOT NULL DEFAULT '#6b7280';

-- +goose Down
ALTER TABLE groups DROP COLUMN color;
