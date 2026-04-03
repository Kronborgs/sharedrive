-- +goose Up
CREATE TABLE system_settings (
  key        TEXT        PRIMARY KEY,
  value      TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_settings (key, value) VALUES
  ('onboarding_complete', 'false'),
  ('instance_id',         gen_random_uuid()::TEXT),
  ('app_name',            'PrivateDrive');

-- +goose Down
DROP TABLE system_settings;
