package backup

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/files"
	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

// Handler is the thin HTTP layer for backup operations.
// All business logic lives in PasswordService, Service, and RestoreService.
type Handler struct {
	passwords *PasswordService
	backups   *Service
	restores  *RestoreService
}

// NewHandler creates a backup Handler. The db and storage instances are
// shared across all three services.
func NewHandler(db *pgxpool.Pool, storage *files.Storage, wrapKey string) *Handler {
	return &Handler{
		passwords: NewPasswordService(db, wrapKey),
		backups:   NewService(db, storage),
		restores:  NewRestoreService(db, storage),
	}
}

// ── GET /api/v1/backup/password ───────────────────────────────────────────────

// GetPassword returns the active backup-password status (no secret material).
func (h *Handler) GetPassword(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	status, err := h.passwords.Status(ctx, u.ID)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, status)
}

// ── POST /api/v1/backup/password ─────────────────────────────────────────────

// GeneratePassword creates a new backup token, revoking any existing one.
// The raw token is returned exactly once and must be saved by the user.
func (h *Handler) GeneratePassword(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	id, token, err := h.passwords.Generate(ctx, u.ID)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusCreated, generatePasswordResponse{ID: id, Token: token})
}

// ── DELETE /api/v1/backup/password ───────────────────────────────────────────

// RevokePassword revokes the active backup password without creating a new one.
func (h *Handler) RevokePassword(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	revoked, err := h.passwords.Revoke(ctx, u.ID)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if !revoked {
		httputil.RespondError(w, http.StatusNotFound, "no active backup password")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── POST /api/v1/backup/export ────────────────────────────────────────────────

type exportRequest struct {
	Token string `json:"token"`
}

// Export streams an AES-256 encrypted .shdbak archive of all the user's files.
// The request body must contain {"token": "<raw backup token>"}.
func (h *Handler) Export(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req exportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" {
		httputil.RespondError(w, http.StatusBadRequest, "token is required")
		return
	}

	if !h.passwords.Verify(ctx, u.ID, req.Token) {
		httputil.RespondError(w, http.StatusForbidden, "invalid backup token")
		return
	}
	h.passwords.TouchLastUsed(ctx, u.ID)

	now := time.Now().UTC()
	filename := fmt.Sprintf("sharedrive-backup-%s.shdbak", now.Format("2006-01-02"))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Cache-Control", "private, no-store")

	if err := h.backups.Export(ctx, w, u.ID, req.Token); err != nil {
		// Headers already sent — status code cannot change. Log only.
		log.Error().Err(err).Str("user_id", u.ID.String()).Msg("backup export")
	}
}

// ── POST /api/v1/backup/restore ───────────────────────────────────────────────

const maxRestoreSize = 10 << 30 // 10 GB

// Restore reads a .shdbak archive from a multipart upload and restores all
// files to the current user's account. Existing files (matched by ID) are
// skipped — the operation is fully idempotent.
func (h *Handler) Restore(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxRestoreSize)
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	token := r.FormValue("token")
	if token == "" {
		httputil.RespondError(w, http.StatusBadRequest, "token is required")
		return
	}

	if !h.passwords.Verify(ctx, u.ID, token) {
		httputil.RespondError(w, http.StatusForbidden, "invalid backup token")
		return
	}

	uploadedFile, _, err := r.FormFile("file")
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "file is required")
		return
	}
	defer uploadedFile.Close()

	// yeka/zip.NewReader requires io.ReaderAt + size; buffer to a temp file.
	tmp, err := os.CreateTemp("", "shdbak-restore-*")
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer func() {
		tmp.Close()
		os.Remove(tmp.Name())
	}()

	size, err := io.Copy(tmp, uploadedFile)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "failed to read archive")
		return
	}

	result, err := h.restores.Restore(ctx, tmp, size, u.ID, token)
	if err != nil {
		log.Error().Err(err).Str("user_id", u.ID.String()).Msg("backup restore")
		httputil.RespondError(w, http.StatusInternalServerError, "restore failed: "+err.Error())
		return
	}
	h.passwords.TouchLastUsed(ctx, u.ID)

	httputil.Respond(w, http.StatusOK, result)
}
