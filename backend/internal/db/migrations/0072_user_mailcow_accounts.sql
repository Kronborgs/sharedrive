-- +goose Up
CREATE TABLE user_mailcow_accounts (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    username TEXT NOT NULL,
    encrypted_password BYTEA NOT NULL
);

-- +goose Down
DROP TABLE user_mailcow_accounts;
