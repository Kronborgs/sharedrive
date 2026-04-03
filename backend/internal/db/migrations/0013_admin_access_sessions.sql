-- +goose Up
CREATE TABLE admin_access_sessions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       UUID        NOT NULL REFERENCES users(id),
  target_user_id UUID        NOT NULL REFERENCES users(id),
  token_hash     TEXT        NOT NULL UNIQUE,
  ended_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_aas_token_hash  ON admin_access_sessions (token_hash);
CREATE INDEX idx_aas_admin       ON admin_access_sessions (admin_id, ended_at)        WHERE ended_at IS NULL;
CREATE INDEX idx_aas_target      ON admin_access_sessions (target_user_id, ended_at)  WHERE ended_at IS NULL;

-- +goose Down
DROP TABLE admin_access_sessions;
