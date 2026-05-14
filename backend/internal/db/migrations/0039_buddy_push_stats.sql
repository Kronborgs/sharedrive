-- +goose Up
-- Track when the user last pushed to their buddy and how many bytes were sent.
ALTER TABLE user_buddy_configs
    ADD COLUMN IF NOT EXISTS last_push_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_push_bytes BIGINT NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE user_buddy_configs
    DROP COLUMN IF EXISTS last_push_at,
    DROP COLUMN IF EXISTS last_push_bytes;
