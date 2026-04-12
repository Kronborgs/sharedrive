-- +goose Up

-- Remove older duplicates for login-type events; keep only the newest per actor.
DELETE FROM audit_logs
WHERE id IN (
    SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY actor_id, event_type
                   ORDER BY created_at DESC
               ) AS rn
        FROM audit_logs
        WHERE event_type IN ('LOGIN_SUCCESS', 'WEBDAV_LOGIN_SUCCESS', 'LOGIN_TOTP_REQUIRED')
          AND actor_id IS NOT NULL
    ) t
    WHERE rn > 1
);

-- Partial unique index so that subsequent inserts can upsert (keep newest only).
CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_dedup_idx
    ON audit_logs (actor_id, event_type)
    WHERE event_type IN ('LOGIN_SUCCESS', 'WEBDAV_LOGIN_SUCCESS', 'LOGIN_TOTP_REQUIRED');

-- +goose Down
DROP INDEX IF EXISTS audit_logs_dedup_idx;
