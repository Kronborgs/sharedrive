-- +goose Up
CREATE TABLE shares (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id  UUID        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  owner_id     UUID        NOT NULL REFERENCES users(id),
  grantee_type TEXT        NOT NULL,
  grantee_id   UUID        NOT NULL,
  can_view     BOOLEAN     NOT NULL DEFAULT TRUE,
  can_upload   BOOLEAN     NOT NULL DEFAULT FALSE,
  can_edit     BOOLEAN     NOT NULL DEFAULT FALSE,
  can_delete   BOOLEAN     NOT NULL DEFAULT FALSE,
  can_reshare  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_by   UUID        NOT NULL REFERENCES users(id),
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_shares_resource_active  ON shares (resource_id, revoked_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_shares_grantee_active   ON shares (grantee_id, grantee_type, revoked_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_shares_owner            ON shares (owner_id);

-- +goose Down
DROP TABLE shares;
