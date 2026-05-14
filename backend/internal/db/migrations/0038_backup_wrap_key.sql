-- +goose Up
-- Ensure backup_wrap_key is present in system_settings.
-- If BACKUP_WRAP_KEY env var is not set the application will generate a random
-- key at startup and upsert it here, so buddy backup works without manual
-- server configuration.
INSERT INTO system_settings (key, value)
VALUES ('backup_wrap_key', encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;

-- +goose Down
DELETE FROM system_settings WHERE key = 'backup_wrap_key';
