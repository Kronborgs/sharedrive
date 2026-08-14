-- +goose Up
ALTER TABLE groups
  ADD COLUMN is_system_managed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE rooms (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  slug             TEXT        NOT NULL,
  owner_id         UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  managed_group_id UUID        NOT NULL UNIQUE REFERENCES groups(id) ON DELETE RESTRICT,
  created_by       UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at      TIMESTAMPTZ,
  CONSTRAINT rooms_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT rooms_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE UNIQUE INDEX idx_rooms_slug_lower ON rooms (lower(slug));
CREATE INDEX idx_rooms_owner ON rooms (owner_id) WHERE archived_at IS NULL;

CREATE TABLE room_members (
  room_id    UUID        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT        NOT NULL DEFAULT 'member',
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (room_id, user_id),
  CONSTRAINT room_members_role CHECK (role IN ('owner', 'moderator', 'member'))
);

CREATE UNIQUE INDEX idx_room_members_single_owner
  ON room_members (room_id) WHERE role = 'owner';
CREATE INDEX idx_room_members_user
  ON room_members (user_id, room_id);

-- +goose Down
DROP TABLE room_members;
DROP TABLE rooms;
ALTER TABLE groups DROP COLUMN is_system_managed;
