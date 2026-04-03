-- +goose Up
CREATE TABLE app_passwords (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  scope         TEXT        NOT NULL DEFAULT 'webdav',
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_app_passwords_user_active ON app_passwords (user_id, revoked_at) WHERE revoked_at IS NULL;

-- +goose Down
DROP TABLE app_passwords;
