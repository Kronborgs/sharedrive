-- +goose Up
-- Fair-trade quota system for buddy backup.
-- receive_quota_bytes: max bytes the local user allows their buddy to store here (NULL = unlimited).
-- peer_stored_bytes: total bytes this user currently has accumulated at their peer's server.
--   Updated after each successful push based on the peer's response.
--   Used to auto-expand the buddy's quota when fair-trade kicks in.
ALTER TABLE user_buddy_configs
    ADD COLUMN IF NOT EXISTS receive_quota_bytes BIGINT NULL,
    ADD COLUMN IF NOT EXISTS peer_stored_bytes   BIGINT NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE user_buddy_configs
    DROP COLUMN IF EXISTS receive_quota_bytes,
    DROP COLUMN IF EXISTS peer_stored_bytes;
