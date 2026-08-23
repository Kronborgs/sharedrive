-- +goose Up
-- Direct conversations existed before groups.  Keep those rows and messages,
-- and evolve the same conversation stream into a participant-based model.
ALTER TABLE direct_conversations
  DROP CONSTRAINT IF EXISTS direct_conversations_user_pair,
  DROP CONSTRAINT IF EXISTS direct_conversations_canonical_pair;

ALTER TABLE direct_conversations
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct', 'group')),
  ADD COLUMN owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN name TEXT;

UPDATE direct_conversations SET owner_user_id = user_one_id WHERE owner_user_id IS NULL;
ALTER TABLE direct_conversations ALTER COLUMN owner_user_id SET NOT NULL;

CREATE TABLE direct_conversation_members (
  conversation_id UUID NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (conversation_id, user_id)
);

INSERT INTO direct_conversation_members(conversation_id, user_id, added_by)
SELECT id, user_one_id, owner_user_id FROM direct_conversations
ON CONFLICT DO NOTHING;
INSERT INTO direct_conversation_members(conversation_id, user_id, added_by)
SELECT id, user_two_id, owner_user_id FROM direct_conversations
ON CONFLICT DO NOTHING;

CREATE INDEX idx_direct_conversation_members_user ON direct_conversation_members(user_id, conversation_id);
CREATE INDEX idx_direct_conversations_owner ON direct_conversations(owner_user_id, updated_at DESC);

-- +goose Down
DROP INDEX IF EXISTS idx_direct_conversations_owner;
DROP INDEX IF EXISTS idx_direct_conversation_members_user;
DROP TABLE direct_conversation_members;
ALTER TABLE direct_conversations
  DROP COLUMN name,
  DROP COLUMN owner_user_id,
  DROP COLUMN kind;
ALTER TABLE direct_conversations
  ADD CONSTRAINT direct_conversations_canonical_pair CHECK (user_one_id < user_two_id),
  ADD CONSTRAINT direct_conversations_user_pair UNIQUE (source_room_id, user_one_id, user_two_id);
