-- +goose Up
CREATE TABLE room_invites (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id          UUID        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  token_hash       CHAR(64)    NOT NULL UNIQUE,
  label            TEXT        NOT NULL DEFAULT '',
  created_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  can_chat         BOOLEAN     NOT NULL DEFAULT TRUE,
  can_upload       BOOLEAN     NOT NULL DEFAULT FALSE,
  can_voice        BOOLEAN     NOT NULL DEFAULT FALSE,
  can_share_screen BOOLEAN     NOT NULL DEFAULT FALSE,
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT room_invites_label_length CHECK (char_length(label) <= 120),
  CONSTRAINT room_invites_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX idx_room_invites_room ON room_invites (room_id, created_at DESC);
CREATE INDEX idx_room_invites_active_expiry ON room_invites (expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE room_guest_sessions (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id          UUID        NOT NULL REFERENCES room_invites(id) ON DELETE CASCADE,
  session_token_hash CHAR(64)    NOT NULL UNIQUE,
  display_name       TEXT        NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  last_accessed_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT room_guest_sessions_name_length CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 80),
  CONSTRAINT room_guest_sessions_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX idx_room_guest_sessions_invite ON room_guest_sessions (invite_id);
CREATE INDEX idx_room_guest_sessions_active_expiry ON room_guest_sessions (expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE room_messages
  ALTER COLUMN sender_user_id DROP NOT NULL,
  ADD COLUMN sender_guest_session_id UUID REFERENCES room_guest_sessions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT room_messages_single_sender CHECK (
    (sender_user_id IS NOT NULL) <> (sender_guest_session_id IS NOT NULL)
  );

ALTER TABLE room_reactions
  DROP CONSTRAINT room_reactions_pkey,
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN guest_session_id UUID REFERENCES room_guest_sessions(id) ON DELETE CASCADE,
  ADD CONSTRAINT room_reactions_single_actor CHECK (
    (user_id IS NOT NULL) <> (guest_session_id IS NOT NULL)
  );

CREATE UNIQUE INDEX idx_room_reactions_user
  ON room_reactions (message_id, user_id, emoji) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_room_reactions_guest
  ON room_reactions (message_id, guest_session_id, emoji) WHERE guest_session_id IS NOT NULL;

CREATE TABLE room_guest_read_state (
  room_id              UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  guest_session_id     UUID NOT NULL REFERENCES room_guest_sessions(id) ON DELETE CASCADE,
  last_read_message_id UUID REFERENCES room_messages(id) ON DELETE SET NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, guest_session_id)
);

CREATE TABLE room_guest_uploads (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id          UUID        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  guest_session_id UUID        NOT NULL REFERENCES room_guest_sessions(id) ON DELETE RESTRICT,
  file_id          UUID        NOT NULL UNIQUE REFERENCES files(id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_room_guest_uploads_session ON room_guest_uploads (guest_session_id, created_at DESC);
CREATE INDEX idx_room_guest_uploads_room ON room_guest_uploads (room_id, created_at DESC);

INSERT INTO system_settings (key, value) VALUES
  ('rooms_guest_uploads_enabled', 'false'),
  ('rooms_guest_upload_max_file_bytes', '26214400'),
  ('rooms_guest_upload_max_files_session', '10'),
  ('rooms_guest_upload_max_files_room_day', '100')
ON CONFLICT (key) DO NOTHING;

-- +goose Down
DELETE FROM system_settings WHERE key IN (
  'rooms_guest_uploads_enabled',
  'rooms_guest_upload_max_file_bytes',
  'rooms_guest_upload_max_files_session',
  'rooms_guest_upload_max_files_room_day'
);
DROP TABLE room_guest_uploads;
DROP TABLE room_guest_read_state;
DROP INDEX idx_room_reactions_guest;
DROP INDEX idx_room_reactions_user;
ALTER TABLE room_reactions
  DROP CONSTRAINT room_reactions_single_actor,
  DROP COLUMN guest_session_id,
  ALTER COLUMN user_id SET NOT NULL,
  ADD PRIMARY KEY (message_id, user_id, emoji);
ALTER TABLE room_messages
  DROP CONSTRAINT room_messages_single_sender,
  DROP COLUMN sender_guest_session_id,
  ALTER COLUMN sender_user_id SET NOT NULL;
DROP TABLE room_guest_sessions;
DROP TABLE room_invites;
