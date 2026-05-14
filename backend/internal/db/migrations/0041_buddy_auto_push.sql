-- +goose Up
ALTER TABLE user_buddy_configs
    ADD COLUMN IF NOT EXISTS auto_push_enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS auto_push_interval_hours INT         NOT NULL DEFAULT 24,
    ADD COLUMN IF NOT EXISTS auto_push_on_change      BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS auto_push_last_run_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS auto_push_last_hash      TEXT        NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS auto_push_folder_ids     TEXT[]      NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE user_buddy_configs
    DROP COLUMN IF EXISTS auto_push_enabled,
    DROP COLUMN IF EXISTS auto_push_interval_hours,
    DROP COLUMN IF EXISTS auto_push_on_change,
    DROP COLUMN IF EXISTS auto_push_last_run_at,
    DROP COLUMN IF EXISTS auto_push_last_hash,
    DROP COLUMN IF EXISTS auto_push_folder_ids;
