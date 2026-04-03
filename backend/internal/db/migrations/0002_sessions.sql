-- +goose Up
CREATE TABLE sessions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       TEXT        NOT NULL UNIQUE,
  ip_address       TEXT,
  user_agent       TEXT,
  is_admin_session BOOLEAN     NOT NULL DEFAULT FALSE,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX idx_sessions_user_active ON sessions (user_id, revoked_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_expires     ON sessions (expires_at);

-- +goose Down
DROP TABLE sessions;
