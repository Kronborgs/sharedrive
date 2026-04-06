-- +goose Up

-- Add force-password-reset flag
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- Fix FK constraints to allow hard-deleting a user record.

-- files.owner_id → cascade (user's files are deleted with the user)
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_owner_id_fkey;
ALTER TABLE files ADD CONSTRAINT files_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;

-- shares.owner_id → cascade; shares.created_by → set null
ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_owner_id_fkey;
ALTER TABLE shares ADD CONSTRAINT shares_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE shares DROP CONSTRAINT IF EXISTS shares_created_by_fkey;
ALTER TABLE shares ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE shares ADD CONSTRAINT shares_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- groups.created_by → set null
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_created_by_fkey;
ALTER TABLE groups ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE groups ADD CONSTRAINT groups_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- tags.created_by → set null
ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_created_by_fkey;
ALTER TABLE tags ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE tags ADD CONSTRAINT tags_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- admin_access_sessions → cascade both sides
ALTER TABLE admin_access_sessions DROP CONSTRAINT IF EXISTS admin_access_sessions_admin_id_fkey;
ALTER TABLE admin_access_sessions ADD CONSTRAINT admin_access_sessions_admin_id_fkey
  FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE admin_access_sessions DROP CONSTRAINT IF EXISTS admin_access_sessions_target_user_id_fkey;
ALTER TABLE admin_access_sessions ADD CONSTRAINT admin_access_sessions_target_user_id_fkey
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ip_whitelist.created_by → set null
ALTER TABLE ip_whitelist DROP CONSTRAINT IF EXISTS ip_whitelist_created_by_fkey;
ALTER TABLE ip_whitelist ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE ip_whitelist ADD CONSTRAINT ip_whitelist_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- invitation_tokens.created_by → set null
ALTER TABLE invitation_tokens DROP CONSTRAINT IF EXISTS invitation_tokens_created_by_fkey;
ALTER TABLE invitation_tokens ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE invitation_tokens ADD CONSTRAINT invitation_tokens_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- +goose Down
ALTER TABLE users DROP COLUMN IF EXISTS must_change_password;
