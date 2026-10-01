package auth

import (
  "context"
  "crypto/rand"
  "encoding/json"
  "fmt"
  "math/big"
  "net/http"
  "strings"
  "time"

  "github.com/yourname/privatedrive/internal/httputil"
  "github.com/yourname/privatedrive/internal/middleware"
)

const (
  emailMFAEnabledSetting = "mfa_email_enabled"
  emailMFAEnrollKey = "mfa_email_enroll:"
  emailMFALoginKey = "mfa_email_login:"
  emailMFACodeTTL = 10 * time.Minute
)

func (h *Handler) emailMFAAllowed(ctx context.Context) bool {
  var allowed bool
  _ = h.db.QueryRow(ctx, "SELECT COALESCE((SELECT value = 'true' FROM system_settings WHERE key = $1), false)", emailMFAEnabledSetting).Scan(&allowed)
  return allowed
}

func newEmailMFACode() (string, error) {
  n, err := rand.Int(rand.Reader, big.NewInt(1000000))
  if err != nil { return "", err }
  return fmt.Sprintf("%06d", n.Int64()), nil
}

func (h *Handler) RequestEmailMFA(w http.ResponseWriter, r *http.Request) {
  ctx := r.Context(); u := middleware.UserFromContext(ctx)
  if u == nil { httputil.RespondError(w, http.StatusUnauthorized, "unauthorized"); return }
  if !h.emailMFAAllowed(ctx) || h.mailer == nil { httputil.RespondError(w, http.StatusForbidden, "email MFA is not enabled by the administrator"); return }
  code, err := newEmailMFACode(); if err != nil { httputil.RespondError(w, http.StatusInternalServerError, errInternal); return }
  key := emailMFAEnrollKey + u.ID.String()
  if err = h.rdb.Set(ctx, key, hashToken(code), emailMFACodeTTL).Err(); err != nil { httputil.RespondError(w, http.StatusInternalServerError, errInternal); return }
  if err = h.mailer.SendMFACode(ctx, u.Email, u.DisplayName, code); err != nil { _ = h.rdb.Del(ctx, key).Err(); httputil.RespondError(w, http.StatusInternalServerError, errInternal); return }
  httputil.Respond(w, http.StatusOK, map[string]bool{"sent": true})
}

func (h *Handler) ConfirmEmailMFA(w http.ResponseWriter, r *http.Request) {
  ctx := r.Context(); u := middleware.UserFromContext(ctx)
  if u == nil { httputil.RespondError(w, http.StatusUnauthorized, "unauthorized"); return }
  if !h.emailMFAAllowed(ctx) { httputil.RespondError(w, http.StatusForbidden, "email MFA is not enabled by the administrator"); return }
  var payload map[string]string
  if err := json.NewDecoder(r.Body).Decode(&payload); err != nil { httputil.RespondError(w, http.StatusBadRequest, errInvalidRequest); return }
  key := emailMFAEnrollKey + u.ID.String(); stored, err := h.rdb.GetDel(ctx, key).Result()
  if err != nil || stored != hashToken(strings.TrimSpace(payload["code"])) { httputil.RespondError(w, http.StatusBadRequest, "invalid or expired email MFA code"); return }
  label := strings.TrimSpace(payload["label"]); if label == "" { label = "E-mail" }
  _, err = h.db.Exec(ctx, "INSERT INTO mfa_methods (user_id, method_type, label, email_address) VALUES ($1, 'email', $2, $3) ON CONFLICT (user_id, lower(email_address)) WHERE method_type = 'email' DO UPDATE SET label = EXCLUDED.label, is_active = true, disabled_at = NULL", u.ID, label, strings.ToLower(u.Email))
  if err != nil { httputil.RespondError(w, http.StatusInternalServerError, errInternal); return }
  httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) sendLoginEmailCode(ctx context.Context, userID, email, pendingToken string) error {
  if !h.emailMFAAllowed(ctx) || h.mailer == nil { return nil }
  var active bool
  if err := h.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM mfa_methods WHERE user_id = $1 AND method_type = 'email' AND is_active = true)", userID).Scan(&active); err != nil || !active { return err }
  code, err := newEmailMFACode(); if err != nil { return err }
  key := emailMFALoginKey + pendingToken
  if err = h.rdb.Set(ctx, key, hashToken(code), emailMFACodeTTL).Err(); err != nil { return err }
  if err = h.mailer.SendMFACode(ctx, email, email, code); err != nil { _ = h.rdb.Del(ctx, key).Err(); return err }
  return nil
}

func (h *Handler) validateLoginEmailCode(ctx context.Context, userID, pendingToken, code string) bool {
  key := emailMFALoginKey + pendingToken; stored, err := h.rdb.Get(ctx, key).Result()
  if err != nil || stored != hashToken(strings.TrimSpace(code)) { return false }
  if _, err = h.rdb.Del(ctx, key).Result(); err != nil { return false }
  _, _ = h.db.Exec(ctx, "UPDATE mfa_methods SET last_used_at = now() WHERE user_id = $1 AND method_type = 'email' AND is_active = true", userID)
  return true
}
