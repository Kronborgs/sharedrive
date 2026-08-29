-- +goose Up
-- GIF library entries reference existing Sharedrive files; no media blobs are stored here.
CREATE TABLE room_gif_library (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id      UUID NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '',
  search_terms TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT '',
  created_by   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_room_gif_library_search
  ON room_gif_library USING GIN (to_tsvector('simple', title || ' ' || search_terms || ' ' || category));

-- +goose Down
DROP TABLE room_gif_library;