-- +goose Up
ALTER TABLE users
  ADD COLUMN rooms_access_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN rooms_only_account BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE room_member_invitations (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_token_id UUID        NOT NULL UNIQUE REFERENCES invitation_tokens(id) ON DELETE CASCADE,
  room_id             UUID        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  email               TEXT        NOT NULL,
  role                TEXT        NOT NULL DEFAULT 'member',
  created_by          UUID        REFERENCES users(id) ON DELETE SET NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  accepted_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT room_member_invitations_role CHECK (role IN ('moderator', 'member'))
);

CREATE INDEX idx_room_member_invitations_active
  ON room_member_invitations (room_id, expires_at DESC)
  WHERE accepted_at IS NULL;
CREATE INDEX idx_room_member_invitations_email
  ON room_member_invitations (lower(email));

-- +goose Down
DROP TABLE room_member_invitations;
ALTER TABLE users DROP COLUMN rooms_only_account, DROP COLUMN rooms_access_enabled;
