-- +goose Up
CREATE TABLE totp_credentials (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  encrypted_secret TEXT        NOT NULL,
  backup_codes     TEXT[]      NOT NULL DEFAULT '{}',
  confirmed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- +goose Down
DROP TABLE totp_credentials;
