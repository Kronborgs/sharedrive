package shares

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

// Handler provides HTTP handlers for file sharing.
type Handler struct {
	db *pgxpool.Pool
}

func NewHandler(db *pgxpool.Pool) *Handler {
	return &Handler{db: db}
}

type Share struct {
	ID          string     `json:"id"`
	ResourceID  string     `json:"resource_id"`
	OwnerID     string     `json:"owner_id"`
	GranteeType string     `json:"grantee_type"`
	GranteeID   string     `json:"grantee_id"`
	CanView     bool       `json:"can_view"`
	CanUpload   bool       `json:"can_upload"`
	CanEdit     bool       `json:"can_edit"`
	CanDelete   bool       `json:"can_delete"`
	CanReshare  bool       `json:"can_reshare"`
	ExpiresAt   *time.Time `json:"expires_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
}

type createShareRequest struct {
	ResourceID  string     `json:"resource_id"`
	GranteeType string     `json:"grantee_type"` // "user" or "group"
	GranteeID   string     `json:"grantee_id"`
	CanView     bool       `json:"can_view"`
	CanUpload   bool       `json:"can_upload"`
	CanEdit     bool       `json:"can_edit"`
	CanDelete   bool       `json:"can_delete"`
	CanReshare  bool       `json:"can_reshare"`
	ExpiresAt   *time.Time `json:"expires_at,omitempty"`
}

type updateShareRequest struct {
	CanView    *bool      `json:"can_view"`
	CanUpload  *bool      `json:"can_upload"`
	CanEdit    *bool      `json:"can_edit"`
	CanDelete  *bool      `json:"can_delete"`
	CanReshare *bool      `json:"can_reshare"`
	ExpiresAt  *time.Time `json:"expires_at"`
}

// List handles GET /api/v1/shares — returns shares created by the current user.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	rows, err := h.db.Query(ctx,
		`SELECT id, resource_id, owner_id, grantee_type, grantee_id,
		        can_view, can_upload, can_edit, can_delete, can_reshare,
		        expires_at, created_at
		 FROM shares
		 WHERE owner_id = $1 AND revoked_at IS NULL
		 ORDER BY created_at DESC`,
		u.ID,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	var out []Share
	for rows.Next() {
		var s Share
		if err := rows.Scan(
			&s.ID, &s.ResourceID, &s.OwnerID, &s.GranteeType, &s.GranteeID,
			&s.CanView, &s.CanUpload, &s.CanEdit, &s.CanDelete, &s.CanReshare,
			&s.ExpiresAt, &s.CreatedAt,
		); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if out == nil {
		out = []Share{}
	}
	httputil.Respond(w, http.StatusOK, out)
}

// Create handles POST /api/v1/shares.
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req createShareRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.GranteeType != "user" && req.GranteeType != "group" {
		httputil.RespondError(w, http.StatusBadRequest, "grantee_type must be 'user' or 'group'")
		return
	}
	// Verify the resource belongs to this user
	var exists bool
	_ = h.db.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM files WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL)`,
		req.ResourceID, u.ID,
	).Scan(&exists)
	if !exists {
		httputil.RespondError(w, http.StatusNotFound, "file not found")
		return
	}

	var id string
	err := h.db.QueryRow(ctx,
		`INSERT INTO shares (resource_id, owner_id, grantee_type, grantee_id,
		                     can_view, can_upload, can_edit, can_delete, can_reshare,
		                     created_by, expires_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		 RETURNING id`,
		req.ResourceID, u.ID, req.GranteeType, req.GranteeID,
		req.CanView, req.CanUpload, req.CanEdit, req.CanDelete, req.CanReshare,
		u.ID, req.ExpiresAt,
	).Scan(&id)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusCreated, map[string]string{"id": id})
}

// Update handles PATCH /api/v1/shares/{id}.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	shareID := chi.URLParam(r, "id")

	var req updateShareRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}

	// Build dynamic update — only update provided fields
	sets := []string{"expires_at = $2"}
	args := []interface{}{shareID, req.ExpiresAt}
	argN := 3
	boolFields := map[string]*bool{
		"can_view":   req.CanView,
		"can_upload": req.CanUpload,
		"can_edit":   req.CanEdit,
		"can_delete": req.CanDelete,
		"can_reshare": req.CanReshare,
	}
	for col, val := range boolFields {
		if val != nil {
			sets = append(sets, col+" = $"+strconv.Itoa(argN))
			args = append(args, *val)
			argN++
		}
	}
	args = append(args, u.ID)
	ownerArgN := argN

	q := "UPDATE shares SET "
	for i, s := range sets {
		if i > 0 {
			q += ", "
		}
		q += s
	}
	q += " WHERE id = $1 AND owner_id = $" + strconv.Itoa(ownerArgN) + " AND revoked_at IS NULL"

	tag, err := h.db.Exec(ctx, q, args...)
	if err != nil || tag.RowsAffected() == 0 {
		httputil.RespondError(w, http.StatusNotFound, "share not found")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// Revoke handles DELETE /api/v1/shares/{id}.
func (h *Handler) Revoke(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	shareID := chi.URLParam(r, "id")
	tag, err := h.db.Exec(ctx,
		`UPDATE shares SET revoked_at = now()
		 WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL`,
		shareID, u.ID,
	)
	if err != nil || tag.RowsAffected() == 0 {
		httputil.RespondError(w, http.StatusNotFound, "share not found")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// SharedWithMe handles GET /api/v1/files/shared-with-me.
func (h *Handler) SharedWithMe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	rows, err := h.db.Query(ctx,
		`SELECT s.id, s.resource_id, s.owner_id, s.grantee_type, s.grantee_id,
		        s.can_view, s.can_upload, s.can_edit, s.can_delete, s.can_reshare,
		        s.expires_at, s.created_at
		 FROM shares s
		 WHERE s.revoked_at IS NULL
		   AND (s.expires_at IS NULL OR s.expires_at > now())
		   AND (
		     (s.grantee_type = 'user' AND s.grantee_id = $1)
		     OR
		     (s.grantee_type = 'group' AND s.grantee_id IN (
		       SELECT group_id FROM group_members WHERE user_id = $1
		     ))
		   )
		 ORDER BY s.created_at DESC`,
		u.ID,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rows.Close()

	var out []Share
	for rows.Next() {
		var s Share
		if err := rows.Scan(
			&s.ID, &s.ResourceID, &s.OwnerID, &s.GranteeType, &s.GranteeID,
			&s.CanView, &s.CanUpload, &s.CanEdit, &s.CanDelete, &s.CanReshare,
			&s.ExpiresAt, &s.CreatedAt,
		); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, "internal error")
			return
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if out == nil {
		out = []Share{}
	}
	httputil.Respond(w, http.StatusOK, out)
}

