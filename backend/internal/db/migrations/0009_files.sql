-- +goose Up
CREATE TABLE files (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id       UUID        REFERENCES files(id) ON DELETE CASCADE,
  owner_id        UUID        NOT NULL REFERENCES users(id),
  is_folder       BOOLEAN     NOT NULL DEFAULT FALSE,
  name            TEXT        NOT NULL,
  mime_type       TEXT,
  size_bytes      BIGINT      NOT NULL DEFAULT 0,
  storage_path    TEXT,
  checksum_sha256 TEXT,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_files_owner_parent   ON files (owner_id, parent_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_owner_trash    ON files (owner_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_files_parent         ON files (parent_id)           WHERE deleted_at IS NULL;
CREATE INDEX idx_files_updated        ON files (updated_at DESC);

CREATE TABLE file_tags (
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag_id  UUID NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (file_id, tag_id)
);

-- +goose Down
DROP TABLE file_tags;
DROP TABLE files;
