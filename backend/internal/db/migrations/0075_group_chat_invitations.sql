-- +goose Up
ALTER TABLE direct_chat_invitations ADD COLUMN conversation_id UUID REFERENCES direct_conversations(id) ON DELETE CASCADE;
-- +goose Down
ALTER TABLE direct_chat_invitations DROP COLUMN conversation_id;
