package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/files"
	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

// Handler is the thin HTTP layer for all backup operations.
type Handler struct {
	passwords  *PasswordService
	backups    *Service
	restores   *RestoreService
	tertiary   *TertiaryService
	buddy      *BuddyService
	buddyCfg   *BuddyConfigService
	autoBackup *AutoBackupService

	tertiaryEnabled bool   // true when backupsRoot volume is mounted
	backupsRoot     string // BACKUPS_ROOT path for disk stats
}

// NewHandler creates a backup Handler.
func NewHandler(db *pgxpool.Pool, storage *files.Storage, wrapKey, backupsRoot string) *Handler {
	svc := NewService(db, storage)
	tert := NewTertiaryService(backupsRoot, svc)
	return &Handler{
		passwords:       NewPasswordService(db, wrapKey),
		backups:         svc,
		restores:        NewRestoreService(db, storage),
		tertiary:        tert,
		buddy:           NewBuddyService(backupsRoot, svc),
		buddyCfg:        NewBuddyConfigService(db, wrapKey),
		autoBackup:      NewAutoBackupService(db, wrapKey, tert),
		tertiaryEnabled: backupsRoot != "",
		backupsRoot:     backupsRoot,
	}
}

// ── GET /api/v1/backup/config ────────────────────────────────────────────────

type backupConfigResponse struct {
	TertiaryEnabled bool  `json:"tertiary_enabled"`
	BuddyEnabled    bool  `json:"buddy_enabled"`
	DiskTotalBytes  int64 `json:"disk_total_bytes,omitempty"`
	DiskFreeBytes   int64 `json:"disk_free_bytes,omitempty"`
}

func (h *Handler) GetConfig(w http.ResponseWriter, r *http.Request) {
	resp := backupConfigResponse{
		TertiaryEnabled: h.tertiaryEnabled,
		BuddyEnabled:    true, // always on — per-user configuration via web GUI
	}
	if h.tertiaryEnabled {
		resp.DiskTotalBytes, resp.DiskFreeBytes = diskStats(h.backupsRoot)
	}
	httputil.Respond(w, http.StatusOK, resp)
}

// ── GET /api/v1/backup/password ───────────────────────────────────────────────

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
	Token     string   `json:"token"`
	FolderIDs []string `json:"folder_ids,omitempty"` // nil/empty = export all
}

// Export streams an AES-256 encrypted .shdbak archive.
// Optional folder_ids restricts scope to the listed folders (recursive).
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

	folderIDs, err := parseUUIDs(req.FolderIDs)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid folder_id: "+err.Error())
		return
	}

	if !h.passwords.Verify(ctx, u.ID, req.Token) {
		httputil.RespondError(w, http.StatusForbidden, "invalid backup token")
		return
	}
	h.passwords.TouchLastUsed(ctx, u.ID)

	now := time.Now().UTC()
	// Serve as .zip so 7-Zip, WinZip, etc. recognise the format immediately.
	// The internal .shdbak extension is kept for on-disk tertiary archives.
	fname := fmt.Sprintf("sharedrive-backup-%s.zip", now.Format("2006-01-02"))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, fname))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	if err := h.backups.Export(ctx, w, u.ID, req.Token, folderIDs); err != nil {
		log.Error().Err(err).Str("user_id", u.ID.String()).Msg("backup export")
	}
}

// ── POST /api/v1/backup/restore ───────────────────────────────────────────────

const maxRestoreSize = 10 << 30 // 10 GB

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

	tmp, err := os.CreateTemp("", "shdbak-restore-*")
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer func() { tmp.Close(); os.Remove(tmp.Name()) }()

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

// ── Tertiary backup ───────────────────────────────────────────────────────────

type tertiaryStoreRequest struct {
	Token     string   `json:"token"`
	FolderIDs []string `json:"folder_ids,omitempty"`
}

func (h *Handler) StoreTertiary(w http.ResponseWriter, r *http.Request) {
	if !h.tertiaryEnabled {
		httputil.RespondError(w, http.StatusServiceUnavailable, "tertiary backup not configured")
		return
	}
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req tertiaryStoreRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" {
		httputil.RespondError(w, http.StatusBadRequest, "token is required")
		return
	}

	folderIDs, err := parseUUIDs(req.FolderIDs)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid folder_id: "+err.Error())
		return
	}

	if !h.passwords.Verify(ctx, u.ID, req.Token) {
		httputil.RespondError(w, http.StatusForbidden, "invalid backup token")
		return
	}

	archive, err := h.tertiary.Store(ctx, u.ID, req.Token, folderIDs)
	if err != nil {
		log.Error().Err(err).Str("user_id", u.ID.String()).Msg("tertiary store")
		httputil.RespondError(w, http.StatusInternalServerError, "tertiary store failed")
		return
	}
	h.passwords.TouchLastUsed(ctx, u.ID)
	httputil.Respond(w, http.StatusCreated, archive)
}

func (h *Handler) ListTertiary(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !h.tertiaryEnabled {
		httputil.Respond(w, http.StatusOK, []TertiaryArchive{})
		return
	}
	archives, err := h.tertiary.List(ctx, u.ID)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, archives)
}

func (h *Handler) DownloadTertiary(w http.ResponseWriter, r *http.Request) {
	if !h.tertiaryEnabled {
		httputil.RespondError(w, http.StatusServiceUnavailable, "tertiary backup not configured")
		return
	}
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	filename := chi.URLParam(r, "filename")
	rc, size, err := h.tertiary.Download(u.ID, filename)
	if err != nil {
		if os.IsNotExist(err) || strings.Contains(err.Error(), "invalid filename") {
			httputil.RespondError(w, http.StatusNotFound, "not found")
			return
		}
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rc.Close()

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", size))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	io.Copy(w, rc) //nolint:errcheck
}

func (h *Handler) DeleteTertiary(w http.ResponseWriter, r *http.Request) {
	if !h.tertiaryEnabled {
		httputil.RespondError(w, http.StatusServiceUnavailable, "tertiary backup not configured")
		return
	}
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	filename := chi.URLParam(r, "filename")
	if err := h.tertiary.Delete(u.ID, filename); err != nil {
		if strings.Contains(err.Error(), "invalid filename") {
			httputil.RespondError(w, http.StatusBadRequest, "invalid filename")
			return
		}
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── Buddy backup ──────────────────────────────────────────────────────────────

// ── GET /api/v1/backup/buddy/config ──────────────────────────────────────────

func (h *Handler) GetBuddyConfig(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	status, err := h.buddyCfg.GetStatus(ctx, u.ID)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, status)
}

// ── PUT /api/v1/backup/buddy/config ──────────────────────────────────────────

type setBuddyPeerRequest struct {
	PeerURL    string `json:"peer_url"`
	PeerUserID string `json:"peer_user_id"`
	PeerToken  string `json:"peer_token"`
}

func (h *Handler) SetBuddyPeerConfig(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req setBuddyPeerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.PeerURL == "" || req.PeerUserID == "" || req.PeerToken == "" {
		httputil.RespondError(w, http.StatusBadRequest, "peer_url, peer_user_id, and peer_token are required")
		return
	}
	if _, err := uuid.Parse(req.PeerUserID); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "peer_user_id must be a valid UUID")
		return
	}
	if err := h.buddyCfg.SetPeerConfig(ctx, u.ID, req.PeerURL, req.PeerUserID, req.PeerToken); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── DELETE /api/v1/backup/buddy/config ───────────────────────────────────────

func (h *Handler) ClearBuddyPeerConfig(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := h.buddyCfg.ClearPeerConfig(ctx, u.ID); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── POST /api/v1/backup/buddy/receive-token ───────────────────────────────────

type generateReceiveTokenResponse struct {
	Token  string `json:"token"`
	Prefix string `json:"prefix"`
}

func (h *Handler) GenerateBuddyReceiveToken(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	token, err := h.buddyCfg.GenerateReceiveToken(ctx, u.ID)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusCreated, generateReceiveTokenResponse{
		Token:  token,
		Prefix: token[:8],
	})
}

// ── DELETE /api/v1/backup/buddy/receive-token ─────────────────────────────────

func (h *Handler) RevokeBuddyReceiveToken(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := h.buddyCfg.RevokeReceiveToken(ctx, u.ID); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── POST /api/v1/backup/buddy/push ────────────────────────────────────────────

type buddyPushRequest struct {
	Token     string   `json:"token"`
	FolderIDs []string `json:"folder_ids,omitempty"`
}

func (h *Handler) BuddyPush(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req buddyPushRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" {
		httputil.RespondError(w, http.StatusBadRequest, "token is required")
		return
	}

	folderIDs, err := parseUUIDs(req.FolderIDs)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid folder_id: "+err.Error())
		return
	}

	peerURL, peerUserID, peerToken, err := h.buddyCfg.GetPeerConfig(ctx, u.ID)
	if err != nil {
		httputil.RespondError(w, http.StatusServiceUnavailable, "peer not configured")
		return
	}

	if !h.passwords.Verify(ctx, u.ID, req.Token) {
		httputil.RespondError(w, http.StatusForbidden, "invalid backup token")
		return
	}

	if err := h.buddy.Push(ctx, u.ID, req.Token, folderIDs, peerURL, peerUserID, peerToken); err != nil {
		log.Error().Err(err).Str("user_id", u.ID.String()).Msg("buddy push")
		httputil.RespondError(w, http.StatusBadGateway, "buddy push failed: "+err.Error())
		return
	}
	h.passwords.TouchLastUsed(ctx, u.ID)
	w.WriteHeader(http.StatusNoContent)
}

// BuddyReceive accepts an archive pushed from a peer. Authentication is per-user:
// the bearer token is the receive token the local user generated and shared with their buddy.
func (h *Handler) BuddyReceive(w http.ResponseWriter, r *http.Request) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		httputil.RespondError(w, http.StatusUnauthorized, "missing bearer token")
		return
	}
	token := auth[7:]

	const maxBuddySize = 10 << 30
	r.Body = http.MaxBytesReader(w, r.Body, maxBuddySize)
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	receiverID, err := uuid.Parse(r.FormValue("receiver_user_id"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid receiver_user_id")
		return
	}

	if err := h.buddyCfg.ValidateReceiveToken(r.Context(), receiverID, token); err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, "invalid receive token")
		return
	}

	archiveFile, _, err := r.FormFile("file")
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "file is required")
		return
	}
	defer archiveFile.Close()

	archive, err := h.buddy.Receive(r.Context(), receiverID, archiveFile)
	if err != nil {
		log.Error().Err(err).Str("receiver_user_id", receiverID.String()).Msg("buddy receive")
		httputil.RespondError(w, http.StatusInternalServerError, "receive failed")
		return
	}
	httputil.Respond(w, http.StatusCreated, archive)
}

func (h *Handler) ListBuddyReceived(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	archives, err := h.buddy.ListReceived(u.ID)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, archives)
}

func (h *Handler) DownloadBuddyReceived(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	filename := chi.URLParam(r, "filename")
	rc, size, err := h.buddy.DownloadReceived(u.ID, filename)
	if err != nil {
		if os.IsNotExist(err) || strings.Contains(err.Error(), "invalid filename") {
			httputil.RespondError(w, http.StatusNotFound, "not found")
			return
		}
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	defer rc.Close()

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", size))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	io.Copy(w, rc) //nolint:errcheck
}

func (h *Handler) DeleteBuddyReceived(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	filename := chi.URLParam(r, "filename")
	if err := h.buddy.DeleteReceived(u.ID, filename); err != nil {
		if strings.Contains(err.Error(), "invalid filename") {
			httputil.RespondError(w, http.StatusBadRequest, "invalid filename")
			return
		}
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── GET /api/v1/backup/auto ──────────────────────────────────────────────────

func (h *Handler) GetAutoConfig(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	cfg, err := h.autoBackup.Get(ctx, u.ID)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, cfg)
}

// ── PUT /api/v1/backup/auto ───────────────────────────────────────────────────

type autoConfigRequest struct {
	Enabled       bool     `json:"enabled"`
	IntervalHours int      `json:"interval_hours"`
	RetentionDays int      `json:"retention_days"`
	FolderIDs     []string `json:"folder_ids"`
}

func (h *Handler) SetAutoConfig(w http.ResponseWriter, r *http.Request) {
	if !h.tertiaryEnabled {
		httputil.RespondError(w, http.StatusServiceUnavailable, "tertiary backup not configured")
		return
	}
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req autoConfigRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.IntervalHours < 1 {
		req.IntervalHours = 24
	}
	if err := h.autoBackup.Set(ctx, u.ID, req.Enabled, req.IntervalHours, req.RetentionDays, req.FolderIDs); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	cfg, err := h.autoBackup.Get(ctx, u.ID)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, cfg)
}

// ── helpers ───────────────────────────────────────────────────────────────────

// RunScheduled delegates to AutoBackupService.RunScheduled. Called by the
// server scheduler goroutine every 15 minutes.
func (h *Handler) RunScheduled(ctx context.Context) {
	if h.autoBackup != nil {
		h.autoBackup.RunScheduled(ctx)
	}
}

// parseUUIDs converts a slice of UUID strings to []uuid.UUID.
func parseUUIDs(strs []string) ([]uuid.UUID, error) {
	if len(strs) == 0 {
		return nil, nil
	}
	out := make([]uuid.UUID, 0, len(strs))
	for _, s := range strs {
		id, err := uuid.Parse(s)
		if err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, nil
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
