-- Track auto-backup failures for offline/error retry + 24h email notification.
-- Covers both buddy push (user_buddy_configs) and tertiary auto-backup (user_backup_auto_config).
-- failed_since: set on first failure, cleared on success.
-- notify_on_failure: default TRUE — user can opt out (one preference covers all backup types).
-- last_failure_notified_at: prevents sending the same alert more than once per 24h.

-- Buddy push
ALTER TABLE user_buddy_configs
  ADD COLUMN IF NOT EXISTS push_failed_since         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notify_on_failure         BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS last_failure_notified_at  TIMESTAMPTZ;

-- Tertiary auto-backup
ALTER TABLE user_backup_auto_config
  ADD COLUMN IF NOT EXISTS auto_failed_since         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notify_on_failure         BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS last_failure_notified_at  TIMESTAMPTZ;
