-- +goose Up
CREATE TABLE device_trust_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,
  name        TEXT,
  ip_address  TEXT,
  user_agent  TEXT,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_device_trust_user    ON device_trust_tokens (user_id, revoked_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_device_trust_hash    ON device_trust_tokens (token_hash);

-- +goose Down
DROP TABLE device_trust_tokens;
