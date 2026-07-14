package shares

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

// Mailer is the subset of smtp.Mailer used by this package.
type Mailer interface {
	SendShareNotification(ctx context.Context, toEmail, sharerName, fileName, appURL string) error
	SendShareInvite(ctx context.Context, toEmail, sharerName, fileName, inviteLink string) error
}

// Handler provides HTTP handlers for file sharing.
type Handler struct {
	db     *pgxpool.Pool
	mailer Mailer
	appURL string // base URL of the app, e.g. "https://sharedrive.example.com"
}

func NewHandler(db *pgxpool.Pool, mailer Mailer, appURL string) *Handler {
	return &Handler{db: db, mailer: mailer, appURL: appURL}
}

const (
	shareErrInternal = "internal error"
	shareErrNotFound = "share not found"
)

type shareRecipient struct {
	email        string
	role         string
	userNotFound bool
}

func isValidGranteeType(granteeType string) bool {
	switch granteeType {
	case "user", "group", "link":
		return true
	default:
		return false
	}
}

func (h *Handler) resolveShareRecipient(ctx context.Context, req *createShareRequest) (shareRecipient, int, string) {
	if req.GranteeType != "user" || req.GranteeID != "" {
		return shareRecipient{}, 0, ""
	}
	if req.GranteeEmail == "" {
		return shareRecipient{}, http.StatusBadRequest, "grantee_email is required for user shares"
	}

	var recipient shareRecipient
	err := h.db.QueryRow(ctx,
		`SELECT id, email, role FROM users WHERE email = lower($1) AND is_active = true`,
		req.GranteeEmail,
	).Scan(&req.GranteeID, &recipient.email, &recipient.role)
	if err == nil {
		return recipient, 0, ""
	}

	log.Debug().Str("grantee_email", req.GranteeEmail).Msg("share: grantee not found, creating pending share")
	recipient.userNotFound = true
	return recipient, 0, ""
}

func (h *Handler) lookupShareFileName(ctx context.Context, resourceID string, ownerID uuid.UUID) (string, error) {
	var fileName string
	err := h.db.QueryRow(ctx,
		`SELECT name FROM files
         WHERE id = $1 AND deleted_at IS NULL
           AND (
             owner_id = $2
             OR EXISTS (
               SELECT 1 FROM files p
               WHERE p.id = (SELECT parent_id FROM files WHERE id = $1 AND deleted_at IS NULL)
                 AND p.owner_id = $2
             )
           )`,
		resourceID, ownerID,
	).Scan(&fileName)
	return fileName, err
}

func (h *Handler) shareExists(ctx context.Context, query string, args ...any) bool {
	var exists bool
	_ = h.db.QueryRow(ctx, query, args...).Scan(&exists)
	return exists
}

func (h *Handler) shareConflictMessage(ctx context.Context, req createShareRequest, recipient shareRecipient) string {
	switch {
	case req.GranteeType == "user" && !recipient.userNotFound:
		if h.shareExists(ctx,
			`SELECT EXISTS(SELECT 1 FROM shares WHERE resource_id=$1 AND grantee_id=$2 AND revoked_at IS NULL)`,
			req.ResourceID, req.GranteeID,
		) {
			return "This user already has access to this file"
		}
	case req.GranteeType == "group":
		if h.shareExists(ctx,
			`SELECT EXISTS(SELECT 1 FROM shares WHERE resource_id=$1 AND grantee_id=$2 AND revoked_at IS NULL)`,
			req.ResourceID, req.GranteeID,
		) {
			return "This group already has access to this file"
		}
	case recipient.userNotFound:
		if h.shareExists(ctx,
			`SELECT EXISTS(SELECT 1 FROM shares WHERE resource_id=$1 AND pending_email=lower($2) AND revoked_at IS NULL)`,
			req.ResourceID, req.GranteeEmail,
		) {
			return "An invite has already been sent to this email"
		}
	}
	return ""
}

func shareInviteExpiry(expiresAt *time.Time) time.Time {
	defaultExpiry := time.Now().Add(7 * 24 * time.Hour)
	if expiresAt == nil {
		return defaultExpiry
	}
	cap := time.Now().Add(30 * 24 * time.Hour)
	if expiresAt.After(cap) {
		return cap
	}
	return *expiresAt
}

func (h *Handler) insertInvitationToken(ctx context.Context, email, inviteHash string, ownerID uuid.UUID, expiresAt time.Time) error {
	_, err := h.db.Exec(ctx,
		`INSERT INTO invitation_tokens (email, token_hash, created_by, expires_at)
         VALUES (lower($1), $2, $3, $4)
         ON CONFLICT DO NOTHING`,
		email, inviteHash, ownerID, expiresAt,
	)
	return err
}

func (h *Handler) createPendingShare(ctx context.Context, req createShareRequest, ownerID uuid.UUID, ownerEmail, fileName string) (string, error) {
	inviteToken := uuid.New().String()
	inviteHash := hashTokenSHA256(inviteToken)
	if err := h.insertInvitationToken(ctx, req.GranteeEmail, inviteHash, ownerID, shareInviteExpiry(req.ExpiresAt)); err != nil {
		return "", err
	}

	var shareID string
	err := h.db.QueryRow(ctx,
		`INSERT INTO shares (resource_id, owner_id, grantee_type, grantee_id,
                             can_view, can_upload, can_edit, can_delete, can_reshare,
                             created_by, expires_at, pending_email)
         VALUES ($1, $2, 'pending', NULL, $3, $4, $5, $6, $7, $8, $9, lower($10))
         RETURNING id`,
		req.ResourceID, ownerID,
		req.CanView, req.CanUpload, req.CanEdit, req.CanDelete, req.CanReshare,
		ownerID, req.ExpiresAt, req.GranteeEmail,
	).Scan(&shareID)
	if err != nil {
		return "", err
	}

	if h.mailer != nil {
		inviteLink := h.appURL + "/accept-invite?token=" + inviteToken
		go func() {
			if err := h.mailer.SendShareInvite(context.Background(), req.GranteeEmail, ownerEmail, fileName, inviteLink); err != nil {
				log.Warn().Err(err).Str("to", req.GranteeEmail).Msg("share: failed to send share-invite email")
			}
		}()
	}
	return shareID, nil
}

func buildShareTarget(req createShareRequest) (*string, any, error) {
	if req.GranteeType != "link" {
		return nil, req.GranteeID, nil
	}

	token, err := generateToken()
	if err != nil {
		return nil, nil, err
	}
	return &token, nil, nil
}

func (h *Handler) insertShare(ctx context.Context, req createShareRequest, ownerID uuid.UUID, granteeIDArg any, linkToken *string) (string, error) {
	var id string
	err := h.db.QueryRow(ctx,
		`INSERT INTO shares (resource_id, owner_id, grantee_type, grantee_id,
                             can_view, can_upload, can_edit, can_delete, can_reshare,
                             created_by, expires_at, token)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
		req.ResourceID, ownerID, req.GranteeType, granteeIDArg,
		req.CanView, req.CanUpload, req.CanEdit, req.CanDelete, req.CanReshare,
		ownerID, req.ExpiresAt, linkToken,
	).Scan(&id)
	return id, err
}

func (h *Handler) notifyShareRecipient(ctx context.Context, recipient shareRecipient, ownerID uuid.UUID, ownerEmail, fileName string) {
	if recipient.email == "" || h.mailer == nil {
		return
	}

	if recipient.role == "guest" {
		inviteToken := uuid.New().String()
		inviteHash := hashTokenSHA256(inviteToken)
		_ = h.insertInvitationToken(ctx, recipient.email, inviteHash, ownerID, time.Now().Add(7*24*time.Hour))
		inviteLink := h.appURL + "/accept-invite?token=" + inviteToken
		go func() {
			if err := h.mailer.SendShareInvite(context.Background(), recipient.email, ownerEmail, fileName, inviteLink); err != nil {
				log.Warn().Err(err).Str("to", recipient.email).Msg("failed to send share invite email to guest")
			}
		}()
		return
	}

	go func() {
		if err := h.mailer.SendShareNotification(context.Background(), recipient.email, ownerEmail, fileName, h.appURL); err != nil {
			log.Warn().Err(err).Str("to", recipient.email).Msg("failed to send share notification email")
		}
	}()
}

type Share struct {
	ID                 string     `json:"id"`
	ResourceID         string     `json:"resource_id"`
	OwnerID            string     `json:"owner_id"`
	GranteeType        string     `json:"grantee_type"`
	GranteeID          *string    `json:"grantee_id,omitempty"`
	GranteeEmail       *string    `json:"grantee_email,omitempty"`
	GranteeDisplayName *string    `json:"grantee_display_name,omitempty"`
	GranteeGroupName   *string    `json:"grantee_group_name,omitempty"`
	PendingEmail       *string    `json:"pending_email,omitempty"`
	Token              *string    `json:"token,omitempty"`
	CanView            bool       `json:"can_view"`
	CanUpload          bool       `json:"can_upload"`
	CanEdit            bool       `json:"can_edit"`
	CanDelete          bool       `json:"can_delete"`
	CanReshare         bool       `json:"can_reshare"`
	ExpiresAt          *time.Time `json:"expires_at,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
}

type createShareRequest struct {
	ResourceID   string     `json:"resource_id"`
	GranteeType  string     `json:"grantee_type"`  // "user", "group", or "link"
	GranteeEmail string     `json:"grantee_email"` // resolved to UUID for type=user
	GranteeID    string     `json:"grantee_id"`    // UUID; used directly for group, or looked up for user
	CanView      bool       `json:"can_view"`
	CanUpload    bool       `json:"can_upload"`
	CanEdit      bool       `json:"can_edit"`
	CanDelete    bool       `json:"can_delete"`
	CanReshare   bool       `json:"can_reshare"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
}

type updateShareRequest struct {
	CanView    *bool      `json:"can_view"`
	CanUpload  *bool      `json:"can_upload"`
	CanEdit    *bool      `json:"can_edit"`
	CanDelete  *bool      `json:"can_delete"`
	CanReshare *bool      `json:"can_reshare"`
	ExpiresAt  *time.Time `json:"expires_at"`
}

// List handles GET /api/v1/shares — returns shares created by the current user,
// optionally filtered by ?resource_id=<uuid>.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	resourceID := r.URL.Query().Get("resource_id")

	query := `SELECT s.id, s.resource_id, s.owner_id, s.grantee_type, s.grantee_id,
	                 s.can_view, s.can_upload, s.can_edit, s.can_delete, s.can_reshare,
	                 s.expires_at, s.created_at,
	                 u.email AS grantee_email,
	                 u.display_name AS grantee_display_name,
	                 g.name  AS grantee_group_name,
	                 s.pending_email,
	                 s.token
	          FROM shares s
	          LEFT JOIN users  u ON s.grantee_type = 'user'  AND u.id = s.grantee_id
	          LEFT JOIN groups g ON s.grantee_type = 'group' AND g.id = s.grantee_id
	          WHERE s.owner_id = $1 AND s.revoked_at IS NULL`
	args := []any{u.ID}
	if resourceID != "" {
		query += " AND s.resource_id = $2"
		args = append(args, resourceID)
	}
	query += " ORDER BY s.created_at DESC"

	rows, err := h.db.Query(ctx, query, args...)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
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
			&s.GranteeEmail, &s.GranteeDisplayName, &s.GranteeGroupName, &s.PendingEmail, &s.Token,
		); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
			return
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
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
	if !isValidGranteeType(req.GranteeType) {
		httputil.RespondError(w, http.StatusBadRequest, "grantee_type must be 'user', 'group', or 'link'")
		return
	}

	recipient, status, message := h.resolveShareRecipient(ctx, &req)
	if status != 0 {
		httputil.RespondError(w, status, message)
		return
	}
	if req.GranteeType != "link" && !recipient.userNotFound && req.GranteeID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "grantee_id is required")
		return
	}

	fileName, err := h.lookupShareFileName(ctx, req.ResourceID, u.ID)
	if err != nil {
		log.Debug().Err(err).Str("resource_id", req.ResourceID).Msg("share: file lookup failed")
		httputil.RespondError(w, http.StatusNotFound, "file not found")
		return
	}

	if conflict := h.shareConflictMessage(ctx, req, recipient); conflict != "" {
		httputil.RespondError(w, http.StatusConflict, conflict)
		return
	}
	if recipient.userNotFound {
		shareID, err := h.createPendingShare(ctx, req, u.ID, u.Email, fileName)
		if err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
			return
		}
		httputil.Respond(w, http.StatusCreated, map[string]any{"id": shareID, "pending": true})
		return
	}

	linkToken, granteeIDArg, err := buildShareTarget(req)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
		return
	}

	id, err := h.insertShare(ctx, req, u.ID, granteeIDArg, linkToken)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
		return
	}

	if req.GranteeType == "user" {
		h.notifyShareRecipient(ctx, recipient, u.ID, u.Email, fileName)
	}

	resp := map[string]any{"id": id}
	if linkToken != nil {
		resp["token"] = *linkToken
	}
	httputil.Respond(w, http.StatusCreated, resp)
}

// generateToken returns a 32-byte URL-safe random token.
func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// hashTokenSHA256 returns the hex-encoded SHA-256 of a raw token, matching the
// format used by invitation_tokens.
func hashTokenSHA256(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
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
		"can_view":    req.CanView,
		"can_upload":  req.CanUpload,
		"can_edit":    req.CanEdit,
		"can_delete":  req.CanDelete,
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
		httputil.RespondError(w, http.StatusNotFound, shareErrNotFound)
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
		httputil.RespondError(w, http.StatusNotFound, shareErrNotFound)
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

// SharedWithMe handles GET /api/v1/files/shared-with-me.
// Returns [{share, item}] — each active share the current user is a grantee of,
// joined with the corresponding file/folder metadata.
func (h *Handler) SharedWithMe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	type sharedItem struct {
		ID        string    `json:"id"`
		Name      string    `json:"name"`
		IsFolder  bool      `json:"is_folder"`
		SizeBytes int64     `json:"size_bytes"`
		MimeType  *string   `json:"mime_type"`
		CreatedAt time.Time `json:"created_at"`
	}
	type result struct {
		Share Share      `json:"share"`
		Item  sharedItem `json:"item"`
	}

	rows, err := h.db.Query(ctx,
		`SELECT s.id, s.resource_id, s.owner_id, s.grantee_type, s.grantee_id,
		        s.can_view, s.can_upload, s.can_edit, s.can_delete, s.can_reshare,
		        s.expires_at, s.created_at,
		        f.name, f.is_folder, COALESCE(f.size_bytes, 0), f.mime_type, f.created_at
		 FROM shares s
		 JOIN files f ON f.id = s.resource_id AND f.deleted_at IS NULL
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
		httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
		return
	}
	defer rows.Close()

	var out []result
	for rows.Next() {
		var r result
		if err := rows.Scan(
			&r.Share.ID, &r.Share.ResourceID, &r.Share.OwnerID, &r.Share.GranteeType, &r.Share.GranteeID,
			&r.Share.CanView, &r.Share.CanUpload, &r.Share.CanEdit, &r.Share.CanDelete, &r.Share.CanReshare,
			&r.Share.ExpiresAt, &r.Share.CreatedAt,
			&r.Item.Name, &r.Item.IsFolder, &r.Item.SizeBytes, &r.Item.MimeType, &r.Item.CreatedAt,
		); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
			return
		}
		r.Item.ID = r.Share.ResourceID
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
		return
	}
	if out == nil {
		out = []result{}
	}
	httputil.Respond(w, http.StatusOK, out)
}

// MyShares handles GET /api/v1/files/my-shares.
// Returns [{item, shares}] — all active shares owned by the current user,
// grouped by resource and ordered by file name.
func (h *Handler) MyShares(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	type sharedItem struct {
		ID        string    `json:"id"`
		ParentID  *string   `json:"parent_id"`
		Name      string    `json:"name"`
		FullPath  string    `json:"full_path"`
		IsFolder  bool      `json:"is_folder"`
		SizeBytes int64     `json:"size_bytes"`
		MimeType  *string   `json:"mime_type"`
		CreatedAt time.Time `json:"created_at"`
	}
	type resourceShares struct {
		Item   sharedItem `json:"item"`
		Shares []Share    `json:"shares"`
	}

	rows, err := h.db.Query(ctx,
		`WITH RECURSIVE owned_files AS (
		    SELECT f.id, f.parent_id, f.name, f.name AS full_path
		    FROM files f
		    WHERE f.owner_id = $1 AND f.parent_id IS NULL AND f.deleted_at IS NULL
		    UNION ALL
		    SELECT c.id, c.parent_id, c.name, owned_files.full_path || '/' || c.name
		    FROM files c
		    JOIN owned_files ON c.parent_id = owned_files.id
		    WHERE c.owner_id = $1 AND c.deleted_at IS NULL
		  )
		  SELECT s.id, s.resource_id, s.owner_id, s.grantee_type, s.grantee_id,
		         s.can_view, s.can_upload, s.can_edit, s.can_delete, s.can_reshare,
		         s.expires_at, s.created_at,
		         u.email AS grantee_email,
		         u.display_name AS grantee_display_name,
		         g.name AS grantee_group_name,
		         s.pending_email, s.token,
		         f.name, f.is_folder, COALESCE(f.size_bytes, 0), f.mime_type, f.created_at AS file_created_at,
		         f.parent_id, COALESCE(owned_files.full_path, f.name) AS full_path
		  FROM shares s
		  JOIN files f ON f.id = s.resource_id AND f.deleted_at IS NULL
		  JOIN owned_files ON owned_files.id = f.id
		  LEFT JOIN users u ON s.grantee_type = 'user' AND u.id = s.grantee_id
		  LEFT JOIN groups g ON s.grantee_type = 'group' AND g.id = s.grantee_id
		  WHERE s.owner_id = $1 AND s.revoked_at IS NULL
		  ORDER BY u.display_name NULLS LAST, u.email NULLS LAST, s.pending_email NULLS LAST, g.name NULLS LAST, f.name ASC, s.created_at DESC`,
		u.ID,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
		return
	}
	defer rows.Close()

	grouped := make(map[string]*resourceShares)
	order := []string{}

	for rows.Next() {
		var s Share
		var item sharedItem
		if err := rows.Scan(
			&s.ID, &s.ResourceID, &s.OwnerID, &s.GranteeType, &s.GranteeID,
			&s.CanView, &s.CanUpload, &s.CanEdit, &s.CanDelete, &s.CanReshare,
			&s.ExpiresAt, &s.CreatedAt,
			&s.GranteeEmail, &s.GranteeDisplayName, &s.GranteeGroupName, &s.PendingEmail, &s.Token,
			&item.Name, &item.IsFolder, &item.SizeBytes, &item.MimeType, &item.CreatedAt,
			&item.ParentID, &item.FullPath,
		); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
			return
		}
		item.ID = s.ResourceID
		if _, ok := grouped[s.ResourceID]; !ok {
			grouped[s.ResourceID] = &resourceShares{Item: item}
			order = append(order, s.ResourceID)
		}
		grouped[s.ResourceID].Shares = append(grouped[s.ResourceID].Shares, s)
	}
	if err := rows.Err(); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
		return
	}

	out := make([]resourceShares, 0, len(order))
	for _, id := range order {
		out = append(out, *grouped[id])
	}
	httputil.Respond(w, http.StatusOK, out)
}

// SharedByLink handles GET /api/v1/public/shared/{token} — unauthenticated.
func (h *Handler) SharedByLink(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	token := chi.URLParam(r, "token")
	if token == "" {
		httputil.RespondError(w, http.StatusBadRequest, "missing token")
		return
	}

	type sharedFile struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		SizeBytes int64  `json:"size_bytes"`
		MimeType  string `json:"mime_type"`
		IsFolder  bool   `json:"is_folder"`
	}

	type payload struct {
		Share Share        `json:"share"`
		Item  sharedFile   `json:"item"`
		Items []sharedFile `json:"items,omitempty"` // non-nil only when is_folder=true
	}

	var p payload
	var isFolder bool
	err := h.db.QueryRow(ctx,
		`SELECT s.id, s.resource_id, s.owner_id, s.grantee_type,
		        s.can_view, s.can_upload, s.can_edit, s.can_delete, s.can_reshare,
		        s.expires_at, s.created_at, s.token,
		        f.name, COALESCE(f.size_bytes, 0), COALESCE(f.mime_type, 'application/octet-stream'), f.is_folder
		 FROM shares s
		 JOIN files f ON f.id = s.resource_id
		 WHERE s.token = $1
		   AND s.revoked_at IS NULL
		   AND (s.expires_at IS NULL OR s.expires_at > now())
		   AND f.deleted_at IS NULL`,
		token,
	).Scan(
		&p.Share.ID, &p.Share.ResourceID, &p.Share.OwnerID, &p.Share.GranteeType,
		&p.Share.CanView, &p.Share.CanUpload, &p.Share.CanEdit, &p.Share.CanDelete, &p.Share.CanReshare,
		&p.Share.ExpiresAt, &p.Share.CreatedAt, &p.Share.Token,
		&p.Item.Name, &p.Item.SizeBytes, &p.Item.MimeType, &isFolder,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusNotFound, shareErrNotFound)
		return
	}
	p.Item.ID = p.Share.ResourceID
	p.Item.IsFolder = isFolder

	// For folder shares, return direct children (one level).
	if isFolder && p.Share.CanView {
		rows, err := h.db.Query(ctx,
			`SELECT id, name, COALESCE(size_bytes, 0), COALESCE(mime_type, 'application/octet-stream'), is_folder
			 FROM files
			 WHERE parent_id = $1 AND deleted_at IS NULL
			 ORDER BY is_folder DESC, name ASC`,
			p.Share.ResourceID,
		)
		if err == nil {
			defer rows.Close()
			p.Items = []sharedFile{}
			for rows.Next() {
				var f sharedFile
				if err := rows.Scan(&f.ID, &f.Name, &f.SizeBytes, &f.MimeType, &f.IsFolder); err == nil {
					p.Items = append(p.Items, f)
				}
			}
		}
	}

	httputil.Respond(w, http.StatusOK, p)
}

// SharedFolderChildren handles GET /api/v1/files/shared/{id}/children.
// Returns the direct children of a folder that has been shared with the calling user,
// including cases where an ancestor folder was shared.
func (h *Handler) SharedFolderChildren(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	folderID := chi.URLParam(r, "id")
	if folderID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "missing id")
		return
	}

	// Check that the requesting user has an active share granting access to this folder
	// or any ancestor folder. We walk up via recursive CTE then match against shares.
	var shareOwnerID string
	var canView, canUpload, canEdit, canDelete, canReshare bool
	var folderName string
	err := h.db.QueryRow(ctx,
		`WITH RECURSIVE ancestors AS (
		   SELECT id, parent_id, name FROM files WHERE id = $1 AND deleted_at IS NULL
		   UNION ALL
		   SELECT f.id, f.parent_id, f.name FROM files f JOIN ancestors a ON f.id = a.parent_id WHERE f.deleted_at IS NULL
		 )
		 SELECT s.owner_id, s.can_view, s.can_upload, s.can_edit, s.can_delete, s.can_reshare,
		        (SELECT name FROM files WHERE id = $1)
		 FROM shares s
		 JOIN ancestors a ON a.id = s.resource_id
		 WHERE s.revoked_at IS NULL
		   AND (s.expires_at IS NULL OR s.expires_at > now())
		   AND (
		     (s.grantee_type = 'user' AND s.grantee_id = $2)
		     OR
		     (s.grantee_type = 'group' AND s.grantee_id IN (
		       SELECT group_id FROM group_members WHERE user_id = $2
		     ))
		   )
		 LIMIT 1`,
		folderID, u.ID,
	).Scan(&shareOwnerID, &canView, &canUpload, &canEdit, &canDelete, &canReshare, &folderName)
	if err != nil {
		httputil.RespondError(w, http.StatusForbidden, "not shared with you")
		return
	}

	type childItem struct {
		ID        string  `json:"id"`
		Name      string  `json:"name"`
		IsFolder  bool    `json:"is_folder"`
		SizeBytes int64   `json:"size_bytes"`
		MimeType  *string `json:"mime_type"`
	}

	rows, err := h.db.Query(ctx,
		`SELECT id, name, is_folder, COALESCE(size_bytes, 0), mime_type
		 FROM files
		 WHERE parent_id = $1 AND deleted_at IS NULL
		 ORDER BY is_folder DESC, name ASC`,
		folderID,
	)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
		return
	}
	defer rows.Close()

	children := []childItem{}
	for rows.Next() {
		var c childItem
		if err := rows.Scan(&c.ID, &c.Name, &c.IsFolder, &c.SizeBytes, &c.MimeType); err != nil {
			httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
			return
		}
		children = append(children, c)
	}
	if err := rows.Err(); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, shareErrInternal)
		return
	}

	httputil.Respond(w, http.StatusOK, map[string]any{
		"items":       children,
		"can_view":    canView,
		"can_upload":  canUpload,
		"can_edit":    canEdit,
		"can_delete":  canDelete,
		"can_reshare": canReshare,
		"owner_id":    shareOwnerID,
		"folder_name": folderName,
	})
}
