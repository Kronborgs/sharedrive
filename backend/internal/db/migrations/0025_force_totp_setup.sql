-- +goose Up
-- Allow admins to require a specific user to set up TOTP before using the app.
ALTER TABLE users ADD COLUMN IF NOT EXISTS force_totp_setup boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE users DROP COLUMN IF EXISTS force_totp_setup;
