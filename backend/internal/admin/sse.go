package admin

import (
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

// SSEHandler handles GET /api/v1/me/events — server-sent events for admin banner.
type SSEHandler struct {
	db *pgxpool.Pool
}

func NewSSEHandler(db *pgxpool.Pool) *SSEHandler {
	return &SSEHandler{db: db}
}

// Events streams SSE to the client, primarily for the AdminBanner notification.
// It sends a single "admin_access" event if an admin is currently impersonating
// the user, then keeps the connection alive with heartbeats every 30s.
func (h *SSEHandler) Events(w http.ResponseWriter, r *http.Request) {
	u := middleware.UserFromContext(r.Context())
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	// Check if there's an active admin access session for this user
	type adminInfo struct {
		AdminID    string    `json:"admin_id"`
		AdminEmail string    `json:"admin_email"`
		StartedAt  time.Time `json:"started_at"`
	}

	var info *adminInfo
	row := h.db.QueryRow(r.Context(),
		`SELECT aas.admin_id::TEXT, u.email, aas.created_at
		 FROM admin_access_sessions aas
		 JOIN users u ON u.id = aas.admin_id
		 WHERE aas.target_user_id = $1 AND aas.ended_at IS NULL
		 ORDER BY aas.created_at DESC LIMIT 1`,
		u.ID,
	)
	var ai adminInfo
	if err := row.Scan(&ai.AdminID, &ai.AdminEmail, &ai.StartedAt); err == nil {
		info = &ai
	}

	if info != nil {
		fmt.Fprintf(w, "event: admin_access\ndata: {\"admin_email\":%q,\"started_at\":%q}\n\n",
			info.AdminEmail, info.StartedAt.Format(time.RFC3339))
		flusher.Flush()
	}

	// Heartbeat loop until client disconnects
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			fmt.Fprintf(w, ": heartbeat\n\n")
			flusher.Flush()
		}
	}
}

// ─── Support Access (admin impersonation) ────────────────────────────────────

// SupportAccessHandler provides admin impersonation controls.
type SupportAccessHandler struct {
	db *pgxpool.Pool
}

func NewSupportAccessHandler(db *pgxpool.Pool) *SupportAccessHandler {
	return &SupportAccessHandler{db: db}
}

// Begin handles POST /api/v1/admin/users/{id}/support-access.
func (h *SupportAccessHandler) Begin(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	admin := middleware.UserFromContext(ctx)
	if admin == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	targetID := chi.URLParam(r, "id")

	var inserted string
	err := h.db.QueryRow(ctx,
		`INSERT INTO admin_access_sessions (admin_id, target_user_id, token_hash)
		 VALUES ($1, $2, gen_random_uuid()::TEXT)
		 RETURNING id`,
		admin.ID, targetID,
	).Scan(&inserted)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]string{"session_id": inserted})
}

// End handles POST /api/v1/admin/support-access/{id}/end.
func (h *SupportAccessHandler) End(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	admin := middleware.UserFromContext(ctx)
	if admin == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	sessionID := chi.URLParam(r, "id")
	tag, err := h.db.Exec(ctx,
		`UPDATE admin_access_sessions SET ended_at = now()
		 WHERE id = $1 AND admin_id = $2 AND ended_at IS NULL`,
		sessionID, admin.ID,
	)
	if err != nil || tag.RowsAffected() == 0 {
		httputil.RespondError(w, http.StatusNotFound, "session not found")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}
