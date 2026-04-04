-- +goose Up
-- Allow link shares: grantee_id becomes nullable, add unique token column.
ALTER TABLE shares
  ALTER COLUMN grantee_id DROP NOT NULL,
  ADD COLUMN token TEXT UNIQUE;

CREATE INDEX idx_shares_token ON shares (token) WHERE token IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_shares_token;
ALTER TABLE shares
  DROP COLUMN token,
  ALTER COLUMN grantee_id SET NOT NULL;
