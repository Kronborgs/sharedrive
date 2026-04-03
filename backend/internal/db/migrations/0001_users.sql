-- +goose Up
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                           TEXT        NOT NULL UNIQUE,
  display_name                    TEXT        NOT NULL,
  password_hash                   TEXT        NOT NULL,
  role                            TEXT        NOT NULL DEFAULT 'user',
  is_active                       BOOLEAN     NOT NULL DEFAULT TRUE,
  quota_bytes                     BIGINT      NOT NULL DEFAULT 10737418240,
  quota_used_bytes                BIGINT      NOT NULL DEFAULT 0,
  bandwidth_limit_bytes_per_day   BIGINT,
  webdav_enabled                  BOOLEAN     NOT NULL DEFAULT FALSE,
  invited_by                      UUID        REFERENCES users(id) ON DELETE SET NULL,
  last_login_at                   TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email     ON users (email);
CREATE INDEX idx_users_role      ON users (role);
CREATE INDEX idx_users_is_active ON users (is_active);

-- +goose Down
DROP TABLE users;
