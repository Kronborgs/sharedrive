-- +goose Up
-- Retroactively mark invited users as 'guest'.
-- Any user who was invited (invited_by IS NOT NULL) and is not an admin
-- was created via the share-invite flow and should have role='guest'.
UPDATE users
SET role = 'guest'
WHERE invited_by IS NOT NULL
  AND role = 'user';

-- +goose Down
-- Cannot safely reverse — we don't know which guests were manually promoted.
