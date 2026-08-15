-- +goose Up
-- Rooms-owned data only: chat messages, replies, reactions and read state.
-- Existing files, notes, blobs and media are deliberately excluded.
INSERT INTO system_settings (key, value) VALUES
  ('rooms_max_data_bytes', '524288000')
ON CONFLICT (key) DO NOTHING;

-- +goose Down
DELETE FROM system_settings WHERE key = 'rooms_max_data_bytes';
