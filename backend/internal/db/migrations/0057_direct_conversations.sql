-- +goose Up
CREATE TABLE direct_conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_one_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  user_two_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT direct_conversations_distinct_users CHECK (user_one_id <> user_two_id),
  CONSTRAINT direct_conversations_canonical_pair CHECK (user_one_id < user_two_id),
  CONSTRAINT direct_conversations_user_pair UNIQUE (source_room_id, user_one_id, user_two_id)
);

CREATE TABLE direct_messages (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id        UUID NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  sender_user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body                   TEXT NOT NULL,
  reply_to_message_id    UUID REFERENCES direct_messages(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at              TIMESTAMPTZ,
  deleted_at             TIMESTAMPTZ,
  CONSTRAINT direct_messages_body_not_empty CHECK (char_length(btrim(body)) > 0)
);

CREATE INDEX idx_direct_messages_conversation_created
  ON direct_messages (conversation_id, created_at DESC, id DESC);

CREATE TABLE direct_reactions (
  message_id UUID NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji),
  CONSTRAINT direct_reactions_emoji_length CHECK (char_length(emoji) BETWEEN 1 AND 32)
);

CREATE TABLE direct_read_state (
  conversation_id        UUID NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id   UUID REFERENCES direct_messages(id) ON DELETE SET NULL,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);

-- +goose Down
DROP TABLE direct_read_state;
DROP TABLE direct_reactions;
DROP TABLE direct_messages;
DROP TABLE direct_conversations;
