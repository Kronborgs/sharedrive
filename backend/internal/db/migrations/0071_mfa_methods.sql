-- +goose Up
CREATE TABLE mfa_methods (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method_type      TEXT NOT NULL CHECK (method_type IN ('totp', 'email')),
  label            TEXT NOT NULL DEFAULT '',
  encrypted_secret TEXT,
  email_address    TEXT,
  backup_codes     TEXT[] NOT NULL DEFAULT '{}',
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at     TIMESTAMPTZ,
  disabled_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (method_type = 'totp' AND encrypted_secret IS NOT NULL AND email_address IS NULL)
    OR
    (method_type = 'email' AND encrypted_secret IS NULL AND email_address IS NOT NULL)
  )
);

CREATE INDEX mfa_methods_user_active_idx ON mfa_methods(user_id, is_active);
CREATE UNIQUE INDEX mfa_methods_user_email_idx ON mfa_methods(user_id, lower(email_address))
  WHERE method_type = 'email' AND email_address IS NOT NULL;

INSERT INTO mfa_methods (
  id, user_id, method_type, label, encrypted_secret, backup_codes, is_active, last_used_at, created_at
)
SELECT
  id, user_id, 'totp', 'Authenticator 1', encrypted_secret, backup_codes, TRUE, NULL, created_at
FROM totp_credentials
ON CONFLICT (id) DO NOTHING;

INSERT INTO system_settings (key, value) VALUES ('mfa_email_enabled', 'false'), ('mfa_email_mode', 'backup') ON CONFLICT (key) DO NOTHING;

-- +goose Down
DROP TABLE mfa_methods;

