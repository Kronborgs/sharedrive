-- +goose Up
-- Hiding a private chat is personal.  The other participant keeps their copy
-- and can decide independently whether to remove it.
ALTER TABLE direct_conversation_members ADD COLUMN hidden_at TIMESTAMPTZ;

-- +goose Down
ALTER TABLE direct_conversation_members DROP COLUMN hidden_at;
