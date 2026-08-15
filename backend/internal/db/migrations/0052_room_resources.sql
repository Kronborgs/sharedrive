-- +goose Up
-- A Room resource is a reference only. No file/blob/note content is copied.
CREATE TABLE room_resources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('file', 'note')),
  resource_id   UUID NOT NULL,
  added_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, resource_type, resource_id)
);

CREATE INDEX idx_room_resources_room ON room_resources (room_id, created_at DESC);
CREATE INDEX idx_room_resources_resource ON room_resources (resource_type, resource_id);

-- +goose Down
DROP TABLE room_resources;
