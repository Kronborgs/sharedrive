-- Per-user buddy backup configuration.
-- Each user can configure a peer Sharedrive they push to (peer_url / peer_user_id / peer_token_enc)
-- and generate a receive token so a peer can push archives to them.
CREATE TABLE IF NOT EXISTS user_buddy_configs (
    user_id              UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- Peer server this user pushes to
    peer_url             TEXT        NOT NULL DEFAULT '',
    peer_user_id         TEXT        NOT NULL DEFAULT '',   -- UUID of the receiving user on the peer server
    peer_token_enc       TEXT        NOT NULL DEFAULT '',   -- AES-256-GCM encrypted receive token from peer
    -- Receive token — the peer uses this to authenticate pushes to THIS user
    receive_token_hash   TEXT        NOT NULL DEFAULT '',   -- bcrypt hash of the receive token
    receive_token_prefix VARCHAR(8)  NOT NULL DEFAULT '',   -- first 8 chars for display ("starts with …")
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
