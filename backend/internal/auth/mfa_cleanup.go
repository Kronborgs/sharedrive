package auth

import (
  "context"
  "github.com/jackc/pgx/v5/pgxpool"
)

func deactivateStaleMFAMethods(ctx context.Context, db *pgxpool.Pool, userID string) ([]string, error) {
  rows, err := db.Query(ctx, "UPDATE mfa_methods stale SET is_active = false, disabled_at = now() WHERE stale.user_id = $1 AND stale.is_active = true AND stale.last_used_at IS NOT NULL AND stale.last_used_at < now() - interval '30 days' AND EXISTS (SELECT 1 FROM mfa_methods recent WHERE recent.user_id = stale.user_id AND recent.id <> stale.id AND recent.is_active = true AND recent.last_used_at >= now() - interval '30 days') RETURNING stale.label", userID)
  if err != nil { return nil, err }
  defer rows.Close()
  var labels []string
  for rows.Next() { var label string; if err := rows.Scan(&label); err != nil { return nil, err }; labels = append(labels, label) }
  return labels, rows.Err()
}
