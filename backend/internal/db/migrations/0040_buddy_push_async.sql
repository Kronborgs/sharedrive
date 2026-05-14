-- +goose Up
-- Support async buddy push: track in-progress state and last error.
ALTER TABLE user_buddy_configs
    ADD COLUMN IF NOT EXISTS push_in_progress BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS last_push_error  TEXT        NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE user_buddy_configs
    DROP COLUMN IF EXISTS push_in_progress,
    DROP COLUMN IF EXISTS last_push_error;
