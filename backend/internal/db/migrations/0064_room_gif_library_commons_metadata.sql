-- +goose Up
ALTER TABLE room_gif_library
  ADD COLUMN commons_filename TEXT,
  ADD COLUMN commons_page TEXT,
  ADD COLUMN commons_source_url TEXT,
  ADD COLUMN author TEXT,
  ADD COLUMN attribution TEXT,
  ADD COLUMN license_name TEXT,
  ADD COLUMN license_url TEXT;

CREATE UNIQUE INDEX idx_room_gif_library_commons_filename
  ON room_gif_library (commons_filename)
  WHERE commons_filename IS NOT NULL;

-- +goose Down
DROP INDEX idx_room_gif_library_commons_filename;
ALTER TABLE room_gif_library
  DROP COLUMN license_url,
  DROP COLUMN license_name,
  DROP COLUMN attribution,
  DROP COLUMN author,
  DROP COLUMN commons_source_url,
  DROP COLUMN commons_page,
  DROP COLUMN commons_filename;
