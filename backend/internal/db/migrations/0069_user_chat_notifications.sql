-- +goose Up
ALTER TABLE users
  ADD COLUMN chat_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- +goose Down
ALTER TABLE users DROP COLUMN chat_notifications_enabled;
