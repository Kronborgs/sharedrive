-- +goose Up
-- Per-user maximum file upload size. NULL = use system-wide default (from system_settings).
ALTER TABLE users ADD COLUMN max_upload_bytes BIGINT NULL;

-- +goose Down
ALTER TABLE users DROP COLUMN max_upload_bytes;
