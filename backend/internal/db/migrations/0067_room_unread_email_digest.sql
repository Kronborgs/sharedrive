-- +goose Up
CREATE TABLE room_unread_email_digest (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_sent_at TIMESTAMPTZ
);

-- Preserve the existing 12-hour cooldown when upgrading from per-message reminders.
INSERT INTO room_unread_email_digest (user_id, last_sent_at)
SELECT user_id, MAX(last_sent_at)
FROM room_unread_email_notifications
WHERE last_sent_at IS NOT NULL
GROUP BY user_id;

-- +goose Down
