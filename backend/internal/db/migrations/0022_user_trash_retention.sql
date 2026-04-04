-- +goose Up
-- Per-user trash retention period in days (NULL = use system default of 30).
ALTER TABLE users ADD COLUMN trash_retention_days INT;

-- +goose Down
ALTER TABLE users DROP COLUMN trash_retention_days;
