-- +goose Up
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

CREATE TABLE bandwidth_usage (
  id                UUID   PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date              DATE   NOT NULL,
  bytes_uploaded    BIGINT NOT NULL DEFAULT 0,
  bytes_downloaded  BIGINT NOT NULL DEFAULT 0,
  UNIQUE (user_id, date)
);

CREATE INDEX idx_bw_user_date ON bandwidth_usage (user_id, date DESC);

-- +goose Down
DROP TABLE bandwidth_usage;
DROP TABLE invitation_tokens;
