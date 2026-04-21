-- +goose Up
-- Fix files that were migrated from an old server with mime_type = 'application/octet-stream'.
-- Update to the correct MIME type based on file extension so browsers render them properly.
UPDATE files
SET mime_type = CASE lower(substring(name FROM '\.([^.]+)$'))
    WHEN 'jpg'  THEN 'image/jpeg'
    WHEN 'jpeg' THEN 'image/jpeg'
    WHEN 'png'  THEN 'image/png'
    WHEN 'gif'  THEN 'image/gif'
    WHEN 'webp' THEN 'image/webp'
    WHEN 'svg'  THEN 'image/svg+xml'
    WHEN 'bmp'  THEN 'image/bmp'
    WHEN 'ico'  THEN 'image/x-icon'
    WHEN 'tif'  THEN 'image/tiff'
    WHEN 'tiff' THEN 'image/tiff'
    WHEN 'heic' THEN 'image/heic'
    WHEN 'avif' THEN 'image/avif'
    WHEN 'mp4'  THEN 'video/mp4'
    WHEN 'mov'  THEN 'video/quicktime'
    WHEN 'avi'  THEN 'video/x-msvideo'
    WHEN 'mkv'  THEN 'video/x-matroska'
    WHEN 'webm' THEN 'video/webm'
    WHEN 'mp3'  THEN 'audio/mpeg'
    WHEN 'm4a'  THEN 'audio/mp4'
    WHEN 'ogg'  THEN 'audio/ogg'
    WHEN 'flac' THEN 'audio/flac'
    WHEN 'wav'  THEN 'audio/wav'
    WHEN 'pdf'  THEN 'application/pdf'
    WHEN 'zip'  THEN 'application/zip'
    WHEN 'txt'  THEN 'text/plain'
    WHEN 'md'   THEN 'text/markdown'
    WHEN 'json' THEN 'application/json'
    ELSE mime_type
END
WHERE mime_type = 'application/octet-stream'
  AND is_folder = false;

-- +goose Down
-- Cannot reliably reverse — leave as-is on rollback.
