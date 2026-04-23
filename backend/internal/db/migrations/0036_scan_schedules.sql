-- +goose Up
INSERT INTO system_settings (key, value) VALUES
  ('scan_corrupt_schedule', '{"enabled":false,"interval":"daily","hour":2,"day_of_week":1,"day_of_month":1}'),
  ('scan_corrupt_last_run',  ''),
  ('scan_orphan_schedule',  '{"enabled":false,"interval":"daily","hour":3,"day_of_week":1,"day_of_month":1}'),
  ('scan_orphan_last_run',   '')
ON CONFLICT (key) DO NOTHING;

-- +goose Down
DELETE FROM system_settings WHERE key IN (
  'scan_corrupt_schedule', 'scan_corrupt_last_run',
  'scan_orphan_schedule',  'scan_orphan_last_run'
);
