-- +goose Up
CREATE TABLE room_push_subscriptions (
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint_hash            BYTEA PRIMARY KEY,
  subscription_ciphertext  BYTEA NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_room_push_subscriptions_user ON room_push_subscriptions(user_id);

-- +goose Down
DROP TABLE room_push_subscriptions;