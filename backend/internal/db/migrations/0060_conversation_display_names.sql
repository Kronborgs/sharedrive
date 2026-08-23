-- +goose Up
-- A private-chat name is personal to each participant. Group-chat names belong
-- to the owner and are stored on the conversation itself.
ALTER TABLE direct_conversation_members ADD COLUMN display_name TEXT;

-- +goose Down
ALTER TABLE direct_conversation_members DROP COLUMN display_name;
