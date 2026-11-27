-- +goose Up
CREATE TABLE sharedrive_themes (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    accent text NOT NULL,
    image_type text NOT NULL,
    image_data bytea NOT NULL
);

CREATE TABLE hidden_sharedrive_themes (
    id text PRIMARY KEY
);

-- +goose Down
DROP TABLE hidden_sharedrive_themes;
DROP TABLE sharedrive_themes;
