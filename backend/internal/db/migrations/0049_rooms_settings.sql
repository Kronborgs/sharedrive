-- +goose Up
-- Rooms settings are stored with the existing admin-controlled system settings.
-- Future chat and backup phases consume their respective values; defaults are
-- deliberately conservative and Rooms remains disabled until an admin enables it.
INSERT INTO system_settings (key, value) VALUES
  ('rooms_enabled', 'false'),
  ('rooms_chat_max_length', '4000'),
  ('rooms_message_retention_days', '0'),
  ('rooms_backup_enabled', 'true')
ON CONFLICT (key) DO NOTHING;

-- +goose Down
DELETE FROM system_settings
WHERE key IN (
  'rooms_enabled',
  'rooms_chat_max_length',
  'rooms_message_retention_days',
  'rooms_backup_enabled'
);
