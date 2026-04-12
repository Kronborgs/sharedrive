-- +goose Up
ALTER TABLE users ADD COLUMN IF NOT EXISTS playlist_state JSONB;

-- +goose Down
ALTER TABLE users DROP COLUMN IF EXISTS playlist_state;
