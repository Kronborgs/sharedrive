-- +goose Up
CREATE TABLE audit_logs (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type     TEXT        NOT NULL,
  actor_id       UUID        REFERENCES users(id) ON DELETE SET NULL,
  actor_email    TEXT,
  target_user_id UUID        REFERENCES users(id) ON DELETE SET NULL,
  resource_type  TEXT,
  resource_id    UUID,
  resource_name  TEXT,
  metadata       JSONB,
  ip_address     TEXT,
  user_agent     TEXT,
  is_admin_action BOOLEAN    NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_created        ON audit_logs (created_at DESC);
CREATE INDEX idx_audit_actor          ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_target         ON audit_logs (target_user_id, created_at DESC);
CREATE INDEX idx_audit_event_type     ON audit_logs (event_type, created_at DESC);
CREATE INDEX idx_audit_admin_actions  ON audit_logs (is_admin_action, created_at DESC)
  WHERE is_admin_action = TRUE;

-- +goose Down
DROP TABLE audit_logs;
