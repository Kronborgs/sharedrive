-- +goose Up
ALTER TABLE user_backup_auto_config
    ADD COLUMN retention_days INT NOT NULL DEFAULT 30;

-- +goose Down
ALTER TABLE user_backup_auto_config
    DROP COLUMN IF EXISTS retention_days;
