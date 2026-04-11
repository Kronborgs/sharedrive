-- +goose Up
-- Per-user automatic backup schedule configuration for the tertiary tier.
-- The service reads wrapped_key from backup_passwords to get the raw token;
-- no extra token storage is needed here.
CREATE TABLE user_backup_auto_config (
    user_id        UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled        BOOLEAN     NOT NULL DEFAULT FALSE,
    interval_hours INT         NOT NULL DEFAULT 24,  -- 6 | 12 | 24 | 48 | 168
    folder_ids     TEXT[]      NOT NULL DEFAULT '{}', -- empty = all files
    last_hash      TEXT        NOT NULL DEFAULT '',   -- SHA-256 fingerprint of last backed-up file tree
    last_run_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- +goose Down
DROP TABLE IF EXISTS user_backup_auto_config;
