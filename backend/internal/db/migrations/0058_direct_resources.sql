-- +goose Up
CREATE TABLE direct_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  added_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  message_id UUID REFERENCES direct_messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(conversation_id, file_id)
);

CREATE INDEX idx_direct_resources_conversation ON direct_resources(conversation_id, created_at DESC);

-- +goose Down
DROP TABLE direct_resources;
