-- +goose Up
-- Remember whether the user has enabled CGNAT reverse-tunnel mode for their buddy backup.
-- When TRUE the server will automatically re-establish the outbound tunnel after restarts
-- or disconnects, so scheduled buddy-pushes never fail silently because the tunnel was lost.
ALTER TABLE user_buddy_configs
    ADD COLUMN IF NOT EXISTS peer_use_tunnel BOOLEAN NOT NULL DEFAULT FALSE;

-- +goose Down
ALTER TABLE user_buddy_configs
    DROP COLUMN IF EXISTS peer_use_tunnel;
