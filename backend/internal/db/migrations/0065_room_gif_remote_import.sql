-- +goose Up
ALTER TABLE room_gif_library
  ADD COLUMN source_url TEXT;

CREATE UNIQUE INDEX idx_room_gif_library_source_url
  ON room_gif_library (source_url)
  WHERE source_url IS NOT NULL;

ALTER TABLE room_resources
  DROP CONSTRAINT room_resources_room_id_resource_type_resource_id_key;

ALTER TABLE direct_resources
  DROP CONSTRAINT direct_resources_conversation_id_file_id_key;

-- +goose Down
ALTER TABLE direct_resources
  ADD CONSTRAINT direct_resources_conversation_id_file_id_key
  UNIQUE (conversation_id, file_id);

ALTER TABLE room_resources
  ADD CONSTRAINT room_resources_room_id_resource_type_resource_id_key
  UNIQUE (room_id, resource_type, resource_id);

DROP INDEX IF EXISTS idx_room_gif_library_source_url;
ALTER TABLE room_gif_library DROP COLUMN source_url;
