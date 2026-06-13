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
	"nhooyr.io/websocket"

	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/files"
	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
	"github.com/yourname/privatedrive/internal/ratelimit"
)

// Handler is the thin HTTP layer for all backup operations.
type Handler struct {
	db         *pgxpool.Pool
	passwords  *PasswordService
	backups    *Service
	restores   *RestoreService
	tertiary   *TertiaryService
	buddy      *BuddyService
	buddyCfg   *BuddyConfigService
	autoBackup *AutoBackupService
	auditSvc   audit.Logger
	limiter    *ratelimit.Limiter

	tertiaryEnabled bool   // true when backupsRoot volume is mounted
	buddyEnabled    bool   // true when buddyRoot is resolvable (independent of tertiaryEnabled)
	backupsRoot     string // BACKUPS_ROOT path for disk stats

	// Reverse tunnel support — lets a public instance push to CGNAT peers.
	tunnelMgr    *TunnelManager // server side: manages sessions from CGNAT peers
	tunnelClient *TunnelClient  // client side: outbound tunnel to peer
}

// NewHandler creates a backup Handler.
// backupsRoot is the tertiary/3-2-1 storage path (BACKUPS_ROOT — may be empty).
// buddyRoot is the path for buddy-received archives (always set; uses /data/backups by default).
func NewHandler(db *pgxpool.Pool, storage *files.Storage, wrapKey, backupsRoot, buddyRoot string, auditSvc audit.Logger, limiter *ratelimit.Limiter) *Handler {
	svc := NewService(db, storage)
	tert := NewTertiaryService(backupsRoot, svc)
	buddySvc := NewBuddyService(buddyRoot, svc)
	buddyCfgSvc := NewBuddyConfigService(db, wrapKey)
	autoSvc := NewAutoBackupService(db, wrapKey, tert, buddySvc, buddyCfgSvc, auditSvc)
	tm := NewTunnelManager()
	tc := NewTunnelClient("")
	buddySvc.SetTunnelManager(tm)
	buddySvc.SetTunnelClient(tc)
	return &Handler{
		db:              db,
		passwords:       NewPasswordService(db, wrapKey),
		backups:         svc,
		restores:        NewRestoreService(db, storage),
		tertiary:        tert,
		buddy:           buddySvc,
		buddyCfg:        buddyCfgSvc,
		autoBackup:      autoSvc,
		auditSvc:        auditSvc,
		limiter:         limiter,
		tertiaryEnabled: backupsRoot != "",
		buddyEnabled:    buddyRoot != "",
		backupsRoot:     backupsRoot,
		tunnelMgr:       tm,
		tunnelClient:    tc,
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

	// Rate-limit restore by user: max 5 restores per hour to prevent resource exhaustion.
	if h.limiter != nil {
		allowed, _, _, _ := h.limiter.Allow(ctx, "user_restore:", u.ID.String(), 5, 1*time.Hour)
		if !allowed {
			httputil.RespondError(w, http.StatusTooManyRequests, "too many restore requests — please wait")
			return
		}
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
	if h.auditSvc != nil {
		h.auditSvc.Log(ctx, audit.Event{
			Type:       audit.EventBackupRun,
			ActorID:    &u.ID,
			ActorEmail: u.Email,
			IPAddress:  middleware.ClientIP(r),
		})
	}
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
		// URL validation errors are user-facing — return 400 with the message.
		// Encryption, wrap key, or DB errors are internal — log and return 500.
		msg := err.Error()
		if strings.Contains(msg, "peer URL") || strings.Contains(msg, "private") || strings.Contains(msg, "HTTPS") || strings.Contains(msg, "hostname") {
			httputil.RespondError(w, http.StatusBadRequest, msg)
		} else {
			log.Error().Err(err).Str("user_id", u.ID.String()).Msg("buddy config: SetPeerConfig failed")
			httputil.RespondError(w, http.StatusInternalServerError, "internal error: "+msg)
		}
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

// ── PUT /api/v1/backup/buddy/quota ────────────────────────────────────────────
// Set (or clear) the max bytes this user allows their buddy to store here.
// Body: {"quota_bytes": 53687091200}  — or {"quota_bytes": null} to remove the cap.

func (h *Handler) SetBuddyQuota(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		QuotaBytes *int64 `json:"quota_bytes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.QuotaBytes != nil && *req.QuotaBytes < 0 {
		httputil.RespondError(w, http.StatusBadRequest, "quota_bytes must be >= 0")
		return
	}
	if err := h.buddyCfg.SetReceiveQuota(ctx, u.ID, req.QuotaBytes); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── GET /api/v1/backup/buddy/server-info (public, no auth) ───────────────────
// Returns this server's preferred upload URL and tunnel capability.

type buddyServerInfoResponse struct {
	DirectUploadURL string `json:"direct_upload_url"` // empty string if not configured
	TunnelSupported bool   `json:"tunnel_supported"`  // true: accepts reverse-tunnel WebSocket
}

func (h *Handler) BuddyServerInfo(w http.ResponseWriter, r *http.Request) {
	var uploadURL string
	_ = h.db.QueryRow(r.Context(),
		`SELECT value FROM system_settings WHERE key = 'direct_upload_url'`,
	).Scan(&uploadURL)
	httputil.Respond(w, http.StatusOK, buddyServerInfoResponse{
		DirectUploadURL: uploadURL,
		TunnelSupported: true, // all instances support inbound tunnel connections
	})
}

// ── GET /api/v1/backup/buddy/tunnel (public WebSocket, peer-token auth) ───────
// A CGNAT peer connects here to establish a reverse tunnel so THIS instance
// can push backup archives back to the peer.
//
// Auth: same as BuddyReceive — Bearer <local-user's receive token>
//   - X-Receiver-User-ID: <local user UUID>
func (h *Handler) BuddyTunnel(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		httputil.RespondError(w, http.StatusUnauthorized, "missing bearer token")
		return
	}
	token := auth[7:]

	receiverIDStr := r.Header.Get("X-Receiver-User-ID")
	receiverID, err := uuid.Parse(receiverIDStr)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid X-Receiver-User-ID header")
		return
	}

	if err := h.buddyCfg.ValidateReceiveToken(ctx, receiverID, token); err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, "invalid receive token")
		return
	}

	// Rate-limit by IP: max 10 tunnel connections per hour.
	if h.limiter != nil {
		ip := middleware.ClientIP(r)
		allowed, _, _, _ := h.limiter.Allow(ctx, "ip_buddy_tunnel:", ip, 10, 1*time.Hour)
		if !allowed {
			httputil.RespondError(w, http.StatusTooManyRequests, "too many tunnel connections")
			return
		}
	}

	// Upgrade to WebSocket. InsecureSkipVerify skips the Origin-check — this
	// endpoint is machine-to-machine, not browser-initiated.
	wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:       []string{"buddy-tunnel"},
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Warn().Err(err).Str("user_id", receiverID.String()).Msg("buddy tunnel: websocket accept")
		return
	}

	nc := websocket.NetConn(ctx, wsConn, websocket.MessageBinary)

	done, err := h.tunnelMgr.Register(receiverID, nc)
	if err != nil {
		log.Error().Err(err).Str("user_id", receiverID.String()).Msg("buddy tunnel: register")
		wsConn.Close(websocket.StatusInternalError, "tunnel setup failed")
		return
	}

	// Block until the yamux session closes (peer disconnect or server shutdown).
	<-done
}

// ── POST /api/v1/backup/buddy/tunnel/connect (authenticated) ─────────────────
// Tells this instance to connect to the peer's tunnel endpoint.
// Used when this instance is behind CGNAT and can't receive direct pushes.

func (h *Handler) BuddyTunnelConnect(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	peerURL, peerUserID, peerToken, err := h.buddyCfg.GetPeerConfig(ctx, u.ID)
	if err != nil {
		httputil.RespondError(w, http.StatusPreconditionRequired, "peer not configured")
		return
	}

	// Connect using a background context so the tunnel outlives this HTTP request.
	if err := h.tunnelClient.Connect(context.Background(), peerURL, peerToken, peerUserID); err != nil {
		httputil.RespondError(w, http.StatusBadGateway, "tunnel connect failed: "+err.Error())
		return
	}

	// Persist the preference so the server auto-reconnects after restarts.
	if err := h.buddyCfg.SetPeerUseTunnel(context.Background(), u.ID, true); err != nil {
		log.Warn().Err(err).Str("user_id", u.ID.String()).Msg("buddy tunnel: failed to persist use_tunnel=true")
	}

	httputil.Respond(w, http.StatusOK, map[string]bool{"connected": true})
}

// ── DELETE /api/v1/backup/buddy/tunnel/connect (authenticated) ───────────────
// Disconnects this instance's outbound tunnel.

func (h *Handler) BuddyTunnelDisconnect(w http.ResponseWriter, r *http.Request) {
	u := middleware.UserFromContext(r.Context())
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	h.tunnelClient.Disconnect()
	// Clear the preference so the server does NOT auto-reconnect after restarts.
	if err := h.buddyCfg.SetPeerUseTunnel(context.Background(), u.ID, false); err != nil {
		log.Warn().Err(err).Str("user_id", u.ID.String()).Msg("buddy tunnel: failed to persist use_tunnel=false")
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── GET /api/v1/backup/buddy/tunnel/status (authenticated) ───────────────────
// Returns whether a reverse tunnel is active in either direction.

type buddyTunnelStatusResponse struct {
	PeerConnectedHere bool `json:"peer_connected_here"` // a CGNAT peer has tunneled TO this instance
	ConnectedToPeer   bool `json:"connected_to_peer"`   // this instance has tunneled TO the peer
}

func (h *Handler) BuddyTunnelStatus(w http.ResponseWriter, r *http.Request) {
	u := middleware.UserFromContext(r.Context())
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	httputil.Respond(w, http.StatusOK, buddyTunnelStatusResponse{
		PeerConnectedHere: h.tunnelMgr.IsConnected(u.ID),
		ConnectedToPeer:   h.tunnelClient.IsConnected(),
	})
}

// ── DELETE /api/v1/backup/buddy/push-in-progress ─────────────────────────────
// Resets a stuck push_in_progress flag (e.g. after a server crash mid-push).

func (h *Handler) ResetBuddyPushInProgress(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := h.buddyCfg.SetPushInProgress(ctx, u.ID, false, ""); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "reset failed")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
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

	// Mark as in-progress synchronously so the UI can reflect it immediately.
	if err := h.buddyCfg.SetPushInProgress(ctx, u.ID, true, ""); err != nil {
		log.Warn().Err(err).Str("user_id", u.ID.String()).Msg("buddy push: failed to set in_progress")
	}

	// Return 202 immediately — the actual push runs in the background.
	w.WriteHeader(http.StatusAccepted)

	// Background goroutine: push to peer and update stats when done.
	// Uses a detached context so the push continues after the HTTP request ends.
	go func() {
		bgCtx := context.Background()
		userID := u.ID
		result, pushErr := h.buddy.Push(bgCtx, userID, req.Token, folderIDs, peerURL, peerUserID, peerToken)
		if pushErr != nil {
			log.Error().Err(pushErr).Str("user_id", userID.String()).Msg("buddy push (async)")
			if pushErr == ErrPeerStorageUnavailable {
				// Peer has no BACKUPS_ROOT — not a transient failure; just clear in-progress.
				_ = h.buddyCfg.SetPushInProgress(bgCtx, userID, false, "")
				return
			}
			if err := h.buddyCfg.SetPushInProgress(bgCtx, userID, false, pushErr.Error()); err != nil {
				log.Warn().Err(err).Str("user_id", userID.String()).Msg("buddy push: failed to record error")
			}
			return
		}
		h.passwords.TouchLastUsed(bgCtx, userID)
		if err := h.buddyCfg.UpdateLastPush(bgCtx, userID, result.ArchiveBytes, result.PeerTotalBytes); err != nil {
			log.Warn().Err(err).Str("user_id", userID.String()).Msg("buddy push: failed to update last push stats")
		}
	}()
}

// BuddyReceive accepts an archive pushed from a peer. Authentication is per-user:
// the bearer token is the receive token the local user generated and shared with their buddy.
func (h *Handler) BuddyReceive(w http.ResponseWriter, r *http.Request) {
	// Buddy storage must be available on this instance to receive and persist archives.
	if !h.buddyEnabled {
		httputil.RespondError(w, http.StatusServiceUnavailable, "buddy backup-lager ikke tilgængeligt på denne server")
		return
	}

	// Rate-limit buddy receive by IP to prevent abuse.
	if h.limiter != nil {
		ip := middleware.ClientIP(r)
		allowed, _, _, _ := h.limiter.Allow(r.Context(), "ip_buddy_recv:", ip, 10, 1*time.Hour)
		if !allowed {
			httputil.RespondError(w, http.StatusTooManyRequests, "too many requests")
			return
		}
	}

	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		httputil.RespondError(w, http.StatusUnauthorized, "missing bearer token")
		return
	}
	token := auth[7:]

	// Buddy receive: up to 10 GiB. The global 4 MiB middleware is bypassed for
	// this route so we apply our own limit here.
	const maxBuddySize = 10 << 30
	r.Body = http.MaxBytesReader(w, r.Body, maxBuddySize)
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		log.Error().Err(err).
			Str("content_type", r.Header.Get("Content-Type")).
			Str("content_length", r.Header.Get("Content-Length")).
			Int64("req_content_length", r.ContentLength).
			Msg("buddy receive: ParseMultipartForm failed")
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

	// ── Quota check (fair-trade) ───────────────────────────────────────────────
	// If the sender identifies themselves we can enforce the configured quota.
	// Effective quota = max(configured quota, bytes we have stored at sender's server).
	if senderIDStr := r.Header.Get("X-Buddy-Sender-User-ID"); senderIDStr != "" {
		if senderID, parseErr := uuid.Parse(senderIDStr); parseErr == nil {
			effective, unlimited, _ := h.buddyCfg.GetReceiveQuota(r.Context(), receiverID, senderID)
			if !unlimited {
				currentTotal, _ := h.buddy.TotalStoredBytes(receiverID)
				// Use Content-Length as upper-bound estimate for the incoming archive.
				incomingEst := r.ContentLength
				if incomingEst < 0 {
					incomingEst = 0
				}
				if currentTotal+incomingEst > effective {
					httputil.RespondError(w, http.StatusInsufficientStorage, "modtage-kvote overskredet")
					return
				}
			}
		}
	}

	archive, err := h.buddy.Receive(r.Context(), receiverID, archiveFile)
	if err != nil {
		log.Error().Err(err).Str("receiver_user_id", receiverID.String()).Msg("buddy receive")
		httputil.RespondError(w, http.StatusInternalServerError, "receive failed")
		return
	}
	// Include total stored bytes so the pusher can update their peer_stored_bytes.
	archive.TotalStoredBytes, _ = h.buddy.TotalStoredBytes(receiverID)
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

// ── GET /api/v1/backup/buddy/sender-archives ──────────────────────────────────
// Public endpoint — authenticated with the receive token (same as BuddyReceive).
// Lets the sender (pusher) list archives they have stored on this instance.
//
//   Authorization: Bearer {receive_token}
//   ?receiver_user_id={UUID}

func (h *Handler) ListSenderArchives(w http.ResponseWriter, r *http.Request) {
	if !h.buddyEnabled {
		httputil.RespondError(w, http.StatusServiceUnavailable, "buddy backup-lager ikke tilgængeligt på denne server")
		return
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		httputil.RespondError(w, http.StatusUnauthorized, "missing bearer token")
		return
	}
	token := auth[7:]
	receiverID, err := uuid.Parse(r.URL.Query().Get("receiver_user_id"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid receiver_user_id")
		return
	}
	if err := h.buddyCfg.ValidateReceiveToken(r.Context(), receiverID, token); err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, "invalid receive token")
		return
	}
	archives, err := h.buddy.ListReceived(receiverID)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, archives)
}

// ── DELETE /api/v1/backup/buddy/sender-archives/{filename} ───────────────────
// Same token-auth as above. Lets the sender remove one of their archives.

func (h *Handler) DeleteSenderArchive(w http.ResponseWriter, r *http.Request) {
	if !h.buddyEnabled {
		httputil.RespondError(w, http.StatusServiceUnavailable, "buddy backup-lager ikke tilgængeligt på denne server")
		return
	}
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		httputil.RespondError(w, http.StatusUnauthorized, "missing bearer token")
		return
	}
	token := auth[7:]
	receiverID, err := uuid.Parse(r.URL.Query().Get("receiver_user_id"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid receiver_user_id")
		return
	}
	if err := h.buddyCfg.ValidateReceiveToken(r.Context(), receiverID, token); err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, "invalid receive token")
		return
	}
	filename := chi.URLParam(r, "filename")
	if err := h.buddy.DeleteReceived(receiverID, filename); err != nil {
		if strings.Contains(err.Error(), "invalid filename") {
			httputil.RespondError(w, http.StatusBadRequest, "invalid filename")
			return
		}
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── GET /api/v1/backup/buddy/pushed ──────────────────────────────────────────
// Authenticated (user session). Proxies to the peer to list archives this user
// has pushed there. Works via tunnel or direct HTTPS.

func (h *Handler) ListPushedArchives(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	cfg, err := h.buddyCfg.GetStatus(ctx, u.ID)
	if err != nil || !cfg.PeerConfigured {
		httputil.RespondError(w, http.StatusBadRequest, "peer not configured")
		return
	}
	peerURL, peerUserID, peerToken, err := h.buddyCfg.GetPeerConfig(ctx, u.ID)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}

	endpoint := strings.TrimRight(peerURL, "/") +
		"/api/v1/backup/buddy/sender-archives?receiver_user_id=" + peerUserID

	var httpClient *http.Client
	if h.tunnelMgr != nil {
		if tr := h.tunnelMgr.HTTPTransport(u.ID); tr != nil {
			httpClient = &http.Client{Transport: tr, Timeout: 30 * time.Second}
			endpoint = "http://tunnel-peer/api/v1/backup/buddy/sender-archives?receiver_user_id=" + peerUserID
		}
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	req.Header.Set("Authorization", "Bearer "+peerToken)

	resp, err := httpClient.Do(req)
	if err != nil {
		httputil.RespondError(w, http.StatusBadGateway, "could not reach peer: "+err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusServiceUnavailable {
		// Peer has no BACKUPS_ROOT configured — no archives stored there.
		httputil.Respond(w, http.StatusOK, []BuddyArchive{})
		return
	}
	if resp.StatusCode != http.StatusOK {
		httputil.RespondError(w, resp.StatusCode, "peer returned error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	io.Copy(w, resp.Body) //nolint:errcheck
}

// ── DELETE /api/v1/backup/buddy/pushed/{filename} ────────────────────────────
// Authenticated (user session). Proxies a delete request to the peer.

func (h *Handler) DeletePushedArchive(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	cfg, err := h.buddyCfg.GetStatus(ctx, u.ID)
	if err != nil || !cfg.PeerConfigured {
		httputil.RespondError(w, http.StatusBadRequest, "peer not configured")
		return
	}
	peerURL2, peerUserID2, peerToken2, err := h.buddyCfg.GetPeerConfig(ctx, u.ID)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	filename := chi.URLParam(r, "filename")

	endpoint := strings.TrimRight(peerURL2, "/") +
		"/api/v1/backup/buddy/sender-archives/" + filename + "?receiver_user_id=" + peerUserID2

	var httpClient *http.Client
	if h.tunnelMgr != nil {
		if tr := h.tunnelMgr.HTTPTransport(u.ID); tr != nil {
			httpClient = &http.Client{Transport: tr, Timeout: 30 * time.Second}
			endpoint = "http://tunnel-peer/api/v1/backup/buddy/sender-archives/" + filename + "?receiver_user_id=" + peerUserID2
		}
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	req.Header.Set("Authorization", "Bearer "+peerToken2)

	resp, err := httpClient.Do(req)
	if err != nil {
		httputil.RespondError(w, http.StatusBadGateway, "could not reach peer: "+err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		httputil.RespondError(w, resp.StatusCode, "peer returned error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── PUT /api/v1/backup/buddy/auto ─────────────────────────────────────────────

type buddyAutoConfigRequest struct {
	Enabled       bool     `json:"enabled"`
	IntervalHours int      `json:"interval_hours"`
	OnChange      bool     `json:"on_change"`
	FolderIDs     []string `json:"folder_ids"`
}

func (h *Handler) SetBuddyAutoConfig(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req buddyAutoConfigRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request")
		return
	}
	if req.IntervalHours < 1 {
		req.IntervalHours = 24
	}
	if err := h.buddyCfg.SetAutoPushConfig(ctx, u.ID, req.Enabled, req.IntervalHours, req.OnChange, req.FolderIDs); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	// Return updated full status so the frontend can update in one round trip.
	status, err := h.buddyCfg.GetStatus(ctx, u.ID)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "internal error")
		return
	}
	httputil.Respond(w, http.StatusOK, status)
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

// SetMailer wires up an SMTP mailer for backup failure notifications.
// Called from server.go after construction.
func (h *Handler) SetMailer(m BackupFailureMailer) {
	if h.autoBackup != nil {
		h.autoBackup.SetMailer(m)
	}
}

// RunScheduled delegates to AutoBackupService.RunScheduled. Called by the
// server scheduler goroutine every 15 minutes.
func (h *Handler) RunScheduled(ctx context.Context) {
	if h.autoBackup != nil {
		h.autoBackup.RunScheduled(ctx)
	}
}

// ── PUT /api/v1/backup/notify ─────────────────────────────────────────────────
// Sets the email-on-failure preference for ALL backup types (buddy + tertiary).

type backupNotifyRequest struct {
	Enabled bool `json:"enabled"`
}

func (h *Handler) SetBackupNotifyConfig(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := middleware.UserFromContext(ctx)
	if u == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req backupNotifyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := h.buddyCfg.SetNotifyOnFailure(ctx, u.ID, req.Enabled); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "failed to save notification preference")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// StartTunnelAutoReconnect launches a background goroutine that keeps the
// outbound CGNAT tunnel alive for any user who has peer_use_tunnel = TRUE.
// It checks the DB once at startup and then every 30 seconds — if the tunnel
// is not connected it re-dials using the stored (encrypted) peer credentials.
// Call this once from server initialisation after NewHandler returns.
func (h *Handler) StartTunnelAutoReconnect(ctx context.Context) {
	go func() {
		reconnect := func() {
			cfg, err := h.buddyCfg.GetTunnelEnabledUser(ctx)
			if err != nil {
				log.Warn().Err(err).Msg("buddy tunnel auto-reconnect: DB lookup failed")
				return
			}
			if cfg == nil {
				return // no user wants a tunnel
			}
			if h.tunnelClient.IsConnected() {
				return // already connected
			}
			log.Info().Str("user_id", cfg.UserID.String()).Str("peer", cfg.PeerURL).
				Msg("buddy tunnel: auto-reconnecting (peer_use_tunnel=true)")
			if err := h.tunnelClient.Connect(ctx, cfg.PeerURL, cfg.PeerToken, cfg.PeerUserID); err != nil {
				log.Warn().Err(err).Str("user_id", cfg.UserID.String()).
					Msg("buddy tunnel: auto-reconnect failed — will retry in 30s")
			}
		}

		// Attempt immediately on startup.
		reconnect()

		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				reconnect()
			}
		}
	}()
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
