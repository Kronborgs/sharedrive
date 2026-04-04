-- +goose Up
-- Ensure admin users created during onboarding are marked active.
-- Earlier versions of the onboarding handler omitted is_active from the INSERT,
-- leaving it at the DB default (false). This migration activates all admin accounts.
UPDATE users SET is_active = true WHERE role = 'admin' AND is_active = false;

-- +goose Down
-- (intentionally a no-op — we cannot know which admins were previously inactive)
