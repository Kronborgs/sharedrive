-- +goose Up
CREATE TABLE notes (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           VARCHAR(16) NOT NULL,
  title          TEXT        NOT NULL DEFAULT '',
  content        TEXT        NOT NULL DEFAULT '',
  color          VARCHAR(32),
  is_pinned      BOOLEAN     NOT NULL DEFAULT FALSE,
  is_archived    BOOLEAN     NOT NULL DEFAULT FALSE,
  hide_completed BOOLEAN     NOT NULL DEFAULT FALSE,
  deleted_at     TIMESTAMPTZ,
  version        BIGINT      NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notes_type_check CHECK (type IN ('text', 'checklist')),
  CONSTRAINT notes_title_length_check CHECK (char_length(title) <= 300),
  CONSTRAINT notes_content_length_check CHECK (char_length(content) <= 100000),
  CONSTRAINT notes_version_check CHECK (version > 0)
);

CREATE INDEX idx_notes_owner_updated ON notes (owner_id, updated_at DESC);
CREATE INDEX idx_notes_owner_active ON notes (owner_id, is_archived, is_pinned, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_notes_owner_deleted ON notes (owner_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE note_items (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id    UUID        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  content    TEXT        NOT NULL DEFAULT '',
  is_checked BOOLEAN     NOT NULL DEFAULT FALSE,
  position   INTEGER     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT note_items_content_length_check CHECK (char_length(content) <= 2000),
  CONSTRAINT note_items_position_check CHECK (position >= 0)
);

CREATE INDEX idx_note_items_note_position ON note_items (note_id, position, created_at);

CREATE TABLE note_shares (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id               UUID        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  created_by            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_email       TEXT        NOT NULL,
  permission            VARCHAR(16) NOT NULL,
  invitation_token_hash CHAR(64)    NOT NULL UNIQUE,
  expires_at            TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  last_sent_at          TIMESTAMPTZ,
  last_opened_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT note_shares_permission_check CHECK (permission IN ('view', 'check', 'edit')),
  CONSTRAINT note_shares_email_check CHECK (
    recipient_email = lower(btrim(recipient_email))
    AND char_length(recipient_email) BETWEEN 3 AND 320
  )
);

CREATE INDEX idx_note_shares_note ON note_shares (note_id, created_at DESC);
CREATE INDEX idx_note_shares_email ON note_shares (recipient_email);
CREATE INDEX idx_note_shares_expiry ON note_shares (expires_at) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX idx_note_shares_active_recipient
  ON note_shares (note_id, recipient_email)
  WHERE revoked_at IS NULL;

CREATE TABLE note_guest_sessions (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id           UUID        NOT NULL REFERENCES note_shares(id) ON DELETE CASCADE,
  session_token_hash CHAR(64)    NOT NULL UNIQUE,
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  last_accessed_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT note_guest_sessions_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX idx_note_guest_sessions_share ON note_guest_sessions (share_id);
CREATE INDEX idx_note_guest_sessions_expiry ON note_guest_sessions (expires_at)
  WHERE revoked_at IS NULL;

-- +goose Down
DROP TABLE IF EXISTS note_guest_sessions;
DROP TABLE IF EXISTS note_shares;
DROP TABLE IF EXISTS note_items;
DROP TABLE IF EXISTS notes;