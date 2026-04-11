-- +goose Up
CREATE TABLE backup_passwords (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT        NOT NULL,
  wrapped_key   BYTEA,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_backup_passwords_user_active
  ON backup_passwords (user_id, revoked_at)
  WHERE revoked_at IS NULL;

-- +goose Down
DROP TABLE backup_passwords;
