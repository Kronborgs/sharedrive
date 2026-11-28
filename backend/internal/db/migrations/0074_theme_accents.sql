-- +goose Up
CREATE TABLE sharedrive_theme_accents (
    theme_id text PRIMARY KEY,
    accent text NOT NULL,
    background text NOT NULL,
    panel text NOT NULL
);

-- +goose Down
DROP TABLE sharedrive_theme_accents;
