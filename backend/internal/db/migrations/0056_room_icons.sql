-- +goose Up
ALTER TABLE rooms
  ADD COLUMN icon_file_id UUID REFERENCES files(id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE rooms DROP COLUMN icon_file_id;
