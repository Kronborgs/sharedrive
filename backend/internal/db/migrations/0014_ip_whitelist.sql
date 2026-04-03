-- +goose Up
CREATE TABLE ip_whitelist (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_cidr     TEXT        NOT NULL UNIQUE,
  description TEXT        NOT NULL DEFAULT '',
  created_by  UUID        NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- +goose Down
DROP TABLE ip_whitelist;
