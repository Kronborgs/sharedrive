-- +goose Up
CREATE TABLE room_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id           UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body              TEXT NOT NULL,
  reply_to_message_id UUID REFERENCES room_messages(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at         TIMESTAMPTZ,
  deleted_at        TIMESTAMPTZ,
  CONSTRAINT room_messages_body_not_empty CHECK (char_length(btrim(body)) > 0)
);

CREATE INDEX idx_room_messages_room_created ON room_messages (room_id, created_at DESC, id DESC);

CREATE TABLE room_reactions (
  message_id UUID NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji),
  CONSTRAINT room_reactions_emoji_length CHECK (char_length(emoji) BETWEEN 1 AND 32)
);

CREATE TABLE room_read_state (
  room_id              UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id UUID REFERENCES room_messages(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

-- +goose Down
DROP TABLE room_read_state;
DROP TABLE room_reactions;
DROP TABLE room_messages;
