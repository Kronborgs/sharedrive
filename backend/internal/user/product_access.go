package user

import (
  "context"
  "encoding/json"
  "net/http"

  "github.com/go-chi/chi/v5"
  "github.com/google/uuid"
  "github.com/jackc/pgx/v5/pgxpool"

  "github.com/yourname/privatedrive/internal/audit"
  "github.com/yourname/privatedrive/internal/httputil"

)

var productNames = []string{"files", "rooms", "notes", "music"}

var productLevels = map[string]bool{"none": true, "limited": true, "full": true}

func LoadProductAccess(ctx context.Context, db *pgxpool.Pool, userID uuid.UUID) (map[string]string, error) {
  rows, err := db.Query(ctx, `SELECT product, access_level FROM user_product_access WHERE user_id = $1`, userID)
  if err != nil { return nil, err }
  defer rows.Close()
  result := make(map[string]string, len(productNames))
  for _, product := range productNames { result[product] = "none" }
  for rows.Next() {
    var product, level string
    if err := rows.Scan(&product, &level); err != nil { return nil, err }
    result[product] = level
  }
  return result, rows.Err()
}

func (h *Handler) attachProductAccess(ctx context.Context, users []*User) error {
  for _, account := range users {
    access, err := LoadProductAccess(ctx, h.db, account.ID)
    if err != nil { return err }
    account.ProductAccess = access
  }
  return nil
}

func (h *Handler) GetProductAccess(w http.ResponseWriter, r *http.Request) {
  id, err := uuid.Parse(chi.URLParam(r, "id"))
  if err != nil { httputil.RespondError(w, http.StatusBadRequest, userErrInvalidRequest); return }
  access, err := LoadProductAccess(r.Context(), h.db, id)
  if err != nil { httputil.RespondError(w, http.StatusInternalServerError, userErrInternal); return }
  httputil.Respond(w, http.StatusOK, map[string]any{"user_id": id, "product_access": access})
}

func (h *Handler) UpdateProductAccess(w http.ResponseWriter, r *http.Request) {
  id, err := uuid.Parse(chi.URLParam(r, "id"))
  if err != nil { httputil.RespondError(w, http.StatusBadRequest, userErrInvalidRequest); return }
  var input struct { Product string `json:"product"`; AccessLevel string `json:"access_level"` }
  if err := json.NewDecoder(r.Body).Decode(&input); err != nil || !isProduct(input.Product) || !productLevels[input.AccessLevel] {
    httputil.RespondError(w, http.StatusBadRequest, "invalid product access")
    return
  }
  var oldLevel string
  err = h.db.QueryRow(r.Context(), `SELECT access_level FROM user_product_access WHERE user_id=$1 AND product=$2`, id, input.Product).Scan(&oldLevel)
  if err != nil { httputil.RespondError(w, http.StatusNotFound, userErrNotFound); return }
  _, err = h.db.Exec(r.Context(), `UPDATE user_product_access SET access_level=$1, updated_at=NOW() WHERE user_id=$2 AND product=$3`, input.AccessLevel, id, input.Product)
  if err != nil { httputil.RespondError(w, http.StatusInternalServerError, userErrInternal); return }
  if input.Product == "rooms" {
    _, err = h.db.Exec(r.Context(), `UPDATE users SET rooms_access_enabled=$1, updated_at=NOW() WHERE id=$2`, input.AccessLevel != "none", id)
    if err != nil { httputil.RespondError(w, http.StatusInternalServerError, userErrInternal); return }
  }
  actor := UserFromContext(r.Context())
  if h.auditSvc != nil && actor != nil && oldLevel != input.AccessLevel {
    h.auditSvc.Log(r.Context(), audit.Event{Type: audit.EventUserProductAccessChanged, ActorID: &actor.ID, TargetUserID: &id, IsAdminAction: true, Metadata: map[string]any{"product": input.Product, "old_access_level": oldLevel, "new_access_level": input.AccessLevel}})
  }
  httputil.Respond(w, http.StatusOK, map[string]any{"product": input.Product, "access_level": input.AccessLevel})
}

func isProduct(value string) bool {
  for _, product := range productNames { if value == product { return true } }
  return false
}