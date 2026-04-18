-- +goose Up
-- Allow an app password to be scoped to a single file or folder.
-- resource_id  — the file/folder the password grants access to (NULL = full WebDAV tree)
-- resource_label — snapshot of the name at creation time (display only)
ALTER TABLE app_passwords
  ADD COLUMN resource_id    UUID REFERENCES files(id) ON DELETE SET NULL,
  ADD COLUMN resource_label TEXT;

-- +goose Down
ALTER TABLE app_passwords
  DROP COLUMN resource_id,
  DROP COLUMN resource_label;
