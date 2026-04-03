-- +goose Up
-- Reshape invitation_tokens to support email-based invitations from admins.
-- Drop and recreate since this is a development migration (no production data).
DROP TABLE IF EXISTS invitation_tokens;

CREATE TABLE invitation_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT        NOT NULL,
  created_by  UUID        NOT NULL REFERENCES users(id),
  token_hash  TEXT        NOT NULL UNIQUE,
  used_at     TIMESTAMPTZ,
  used_by     UUID        REFERENCES users(id),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inv_token_hash ON invitation_tokens (token_hash);
CREATE INDEX idx_inv_email       ON invitation_tokens (email);
CREATE INDEX idx_inv_created_by  ON invitation_tokens (created_by);

-- +goose Down
DROP TABLE invitation_tokens;

CREATE TABLE invitation_tokens (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL UNIQUE,
  used_at    TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inv_token_hash ON invitation_tokens (token_hash);
CREATE INDEX idx_inv_user_id    ON invitation_tokens (user_id);
