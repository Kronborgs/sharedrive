-- +goose Up
-- A private chat may be started from a contact e-mail without requiring both
-- people to share a group chat first.
ALTER TABLE direct_conversations ALTER COLUMN source_room_id DROP NOT NULL;

CREATE TABLE direct_chat_invitations (
  invitation_token_id UUID PRIMARY KEY REFERENCES invitation_tokens(id) ON DELETE CASCADE,
  inviter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_direct_chat_invitations_email
  ON direct_chat_invitations(lower(email)) WHERE accepted_at IS NULL;

-- +goose Down
DROP TABLE direct_chat_invitations;
ALTER TABLE direct_conversations ALTER COLUMN source_room_id SET NOT NULL;
