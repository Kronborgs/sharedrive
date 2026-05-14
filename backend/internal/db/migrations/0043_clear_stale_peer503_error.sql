-- Clear stale last_push_error values that were written before the
-- ErrPeerStorageUnavailable sentinel was introduced. These errors indicate
-- that the peer has no BACKUPS_ROOT configured and should not be shown as
-- persistent failures — the new code silently discards them instead.
UPDATE user_buddy_configs
SET last_push_error = '', updated_at = NOW()
WHERE last_push_error LIKE '%BACKUPS_ROOT%';
