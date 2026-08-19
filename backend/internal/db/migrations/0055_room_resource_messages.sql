-- +goose Up
-- A resource can optionally belong to the chat message that sent it.
ALTER TABLE room_resources
  ADD COLUMN message_id UUID REFERENCES room_messages(id) ON DELETE SET NULL;

CREATE INDEX idx_room_resources_message ON room_resources (message_id)
  WHERE message_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_room_resources_message;
ALTER TABLE room_resources DROP COLUMN message_id;
