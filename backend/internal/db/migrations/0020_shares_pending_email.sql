-- +goose Up
-- Support sharing with users who don't have an account yet.
-- pending_email holds the invited address until they accept and get a real user id.
ALTER TABLE shares ADD COLUMN pending_email TEXT;

CREATE INDEX idx_shares_pending_email ON shares (pending_email) WHERE pending_email IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_shares_pending_email;
ALTER TABLE shares DROP COLUMN pending_email;
