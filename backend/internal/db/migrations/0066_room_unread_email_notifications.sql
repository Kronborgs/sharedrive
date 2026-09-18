-- +goose Up
CREATE TABLE room_unread_email_notifications (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_kind  TEXT NOT NULL CHECK (message_kind IN ('room', 'direct')),
  message_id    UUID NOT NULL,
  last_sent_at  TIMESTAMPTZ,
  PRIMARY KEY (user_id, message_kind, message_id)
);

CREATE INDEX idx_room_unread_email_notifications_due
  ON room_unread_email_notifications (last_sent_at);

-- +goose Down
DROP TABLE room_unread_email_notifications;