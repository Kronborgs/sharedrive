package server

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"strconv"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
	"github.com/tus/tusd/v2/pkg/filestore"
	tusd "github.com/tus/tusd/v2/pkg/handler"

	"github.com/yourname/privatedrive/internal/admin"
	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/auth"
	"github.com/yourname/privatedrive/internal/backup"

	"github.com/yourname/privatedrive/internal/config"
	"github.com/yourname/privatedrive/internal/embed"
	"github.com/yourname/privatedrive/internal/files"
	mw "github.com/yourname/privatedrive/internal/middleware"
	"github.com/yourname/privatedrive/internal/notes"
	"github.com/yourname/privatedrive/internal/onboarding"
	"github.com/yourname/privatedrive/internal/onlyoffice"
	"github.com/yourname/privatedrive/internal/preview"
	"github.com/yourname/privatedrive/internal/ratelimit"
	"github.com/yourname/privatedrive/internal/shares"
	"github.com/yourname/privatedrive/internal/smtp"
	"github.com/yourname/privatedrive/internal/user"
	"github.com/yourname/privatedrive/internal/webdav"
)

const (
	filesRoute             = "/api/v1/files"
	filesUploadRoute       = "/api/v1/files/upload"
	fileByIDRoute          = "/api/v1/files/{id}"
	backupPasswordRoute    = "/api/v1/backup/password"
	backupBuddyConfigRoute = "/api/v1/backup/buddy/config"
	adminUsersByIDRoute    = "/api/v1/admin/users/{id}"
	noteByIDRoute          = "/api/v1/notes/{id}"
	backupsDataRoot        = "/data/backups"
	contentTypeHeader      = "Content-Type"
	jsonContentType        = "application/json"
)

// Server wraps the HTTP server and all application dependencies.
type Server struct {
	cfg            *config.Config
	db             *pgxpool.Pool
	redis          *goredis.Client
	router         *chi.Mux
	http           *http.Server
	version        string
	buildDate      string
	authHandler    *auth.Handler
	onboarding     *onboarding.Handler
	userHandler    *user.Handler
	fileSvc        *files.Service
	filesHandler   *files.Handler
	sharesHandler  *shares.Handler
	notesHandler   *notes.Handler
	adminHandler   *admin.Handler
	sseHandler     *admin.SSEHandler
	supportHandler *admin.SupportAccessHandler
	appPwdHandler  *webdav.AppPasswordHandler
	backupHandler  *backup.Handler
	ooHandler      *onlyoffice.Handler
	auditSvc       audit.Logger
	ioTracker      *files.IOTracker
}

// New constructs a Server with all routes and middleware registered.
func New(cfg *config.Config, db *pgxpool.Pool, rdb *goredis.Client, authHandler *auth.Handler, auditSvc audit.Logger, version, buildDate string) *Server {
	storage := files.NewStorage(cfg.FilesRoot, cfg.FileEncryptKey)
	fileSvc := files.NewService(db, storage)
	trashSvc := files.NewTrashService(db, storage)
	conv := initPreviewConverter(cfg)
	ioTracker := files.NewIOTracker(rdb)

	deps := serverDependencies{
		cfg:         cfg,
		db:          db,
		rdb:         rdb,
		authHandler: authHandler,
		auditSvc:    auditSvc,
		version:     version,
		buildDate:   buildDate,
		storage:     storage,
		fileSvc:     fileSvc,
		trashSvc:    trashSvc,
		conv:        conv,
		ioTracker:   ioTracker,
	}

	s := newServerDependencies(deps)
	s.backupHandler.SetMailer(smtp.New(cfg, db))
	s.router = s.buildRouter()
	startServerBackgroundTasks(s, db, rdb, cfg, storage)
	s.http = newHTTPServer(s, rdb, storage)
	return s
}

func initPreviewConverter(cfg *config.Config) *preview.Converter {
	if cfg.PreviewCacheDir == "" || cfg.GotenbergURL == "" {
		return nil
	}
	conv, err := preview.New(cfg.PreviewCacheDir, cfg.GotenbergURL)
	if err != nil {
		log.Warn().Err(err).Msg("preview: converter init failed — Office preview unavailable")
		return nil
	}
	return conv
}

type serverDependencies struct {
	cfg         *config.Config
	db          *pgxpool.Pool
	rdb         *goredis.Client
	authHandler *auth.Handler
	auditSvc    audit.Logger
	version     string
	buildDate   string
	storage     *files.Storage
	fileSvc     *files.Service
	trashSvc    *files.TrashService
	conv        *preview.Converter
	ioTracker   *files.IOTracker
}

func newServerDependencies(deps serverDependencies) *Server {
	return &Server{
		cfg:           deps.cfg,
		db:            deps.db,
		redis:         deps.rdb,
		version:       deps.version,
		buildDate:     deps.buildDate,
		authHandler:   deps.authHandler,
		onboarding:    onboarding.New(deps.db, deps.cfg),
		userHandler:   user.NewHandler(deps.db, deps.auditSvc, smtp.New(deps.cfg, deps.db), deps.cfg.AppBaseURL, deps.authHandler.TOTPService()),
		fileSvc:       deps.fileSvc,
		filesHandler:  files.NewHandler(deps.fileSvc, deps.trashSvc, deps.auditSvc, deps.rdb, deps.conv, ratelimit.New(deps.rdb), deps.ioTracker),
		sharesHandler: shares.NewHandler(deps.db, smtp.New(deps.cfg, deps.db), deps.cfg.AppBaseURL),
		notesHandler: notes.NewHandler(
			notes.NewService(deps.db, deps.auditSvc),
			notes.NewSharingService(deps.db, smtp.New(deps.cfg, deps.db), deps.auditSvc,
				ratelimit.New(deps.rdb), deps.cfg.AppBaseURL, deps.cfg.GoEnv == "production"),
		),
		adminHandler:   admin.NewHandler(deps.db, deps.cfg, deps.ioTracker, deps.rdb),
		sseHandler:     admin.NewSSEHandler(deps.db),
		supportHandler: admin.NewSupportAccessHandler(deps.db),
		appPwdHandler:  webdav.NewAppPasswordHandler(deps.db),
		backupHandler:  backup.NewHandler(deps.db, deps.storage, deps.cfg.BackupWrapKey, backupsRoot(deps.cfg.BackupsRoot), buddyStorageRoot(deps.cfg.BackupsRoot, deps.cfg.FilesRoot), deps.auditSvc, ratelimit.New(deps.rdb)),
		ooHandler:      onlyoffice.NewHandler(deps.db, deps.storage, deps.cfg.AppBaseURL, deps.rdb),
		auditSvc:       deps.auditSvc,
		ioTracker:      deps.ioTracker,
	}
}

func startServerBackgroundTasks(s *Server, db *pgxpool.Pool, rdb *goredis.Client, cfg *config.Config, storage *files.Storage) {
	s.backupHandler.StartTunnelAutoReconnect(context.Background())
	startPreviewCleanup(cfg)
	startTusCleanup(cfg)
	startAutoBackupScheduler(s)
	startStartupOrphanCascade(db)
	startStartupQuotaRecalc(db)
	startBuddyPushReset(db)
	startStartupStorageScrub(db, cfg)
}

func startPreviewCleanup(cfg *config.Config) {
	if cfg.PreviewCacheDir == "" {
		return
	}
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			if err := cleanPreviewCache(cfg.PreviewCacheDir); err != nil {
				log.Warn().Err(err).Msg("preview cache cleanup")
			}
		}
	}()
}

func startTusCleanup(cfg *config.Config) {
	go func() {
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			if err := cleanTusUploadDir(cfg.TusUploadDir); err != nil {
				log.Warn().Err(err).Msg("tus upload dir cleanup")
			}
		}
	}()
}

func startAutoBackupScheduler(s *Server) {
	go func() {
		ticker := time.NewTicker(15 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			s.backupHandler.RunScheduled(context.Background())
		}
	}()
}

func startStartupOrphanCascade(db *pgxpool.Pool) {
	go func() {
		ctx := context.Background()
		tag, err := db.Exec(ctx, `
			WITH RECURSIVE orphans AS (
			  SELECT f.id, p.deleted_at AS p_deleted_at, p.owner_id AS p_owner_id
			  FROM files f
			  JOIN files p ON p.id = f.parent_id
			  WHERE p.deleted_at IS NOT NULL AND f.deleted_at IS NULL
			  UNION ALL
			  SELECT f.id, o.p_deleted_at, o.p_owner_id
			  FROM files f
			  JOIN orphans o ON o.id = f.parent_id
			  WHERE f.deleted_at IS NULL
			)
			UPDATE files
			SET deleted_at = o.p_deleted_at,
			    owner_id   = o.p_owner_id,
			    updated_at = now()
			FROM orphans o
			WHERE files.id = o.id`)
		if err != nil {
			log.Warn().Err(err).Msg("startup orphan cascade failed")
			return
		}
		log.Info().Int64("rows", tag.RowsAffected()).Msg("startup orphan cascade completed")
	}()
}

func startStartupQuotaRecalc(db *pgxpool.Pool) {
	go func() {
		ctx := context.Background()
		if _, err := db.Exec(ctx, `
			UPDATE users u
			SET quota_used_bytes = COALESCE((
			      SELECT sum(size_bytes)
			      FROM files
			      WHERE owner_id = u.id AND deleted_at IS NULL AND is_folder = false
			    ), 0),
			    updated_at = now()`); err != nil {
			log.Warn().Err(err).Msg("startup quota recalc failed")
			return
		}
		log.Info().Msg("startup quota recalc completed")
	}()
}

func startBuddyPushReset(db *pgxpool.Pool) {
	go func() {
		ctx := context.Background()
		if tag, err := db.Exec(ctx, `UPDATE user_buddy_configs SET push_in_progress = FALSE WHERE push_in_progress = TRUE`); err != nil {
			log.Warn().Err(err).Msg("startup buddy push_in_progress reset failed")
		} else if tag.RowsAffected() > 0 {
			log.Info().Int64("rows", tag.RowsAffected()).Msg("startup: reset stuck buddy push_in_progress flags")
		}
	}()
}

func startStartupStorageScrub(db *pgxpool.Pool, cfg *config.Config) {
	go func() {
		result, err := admin.RunStorageScrub(context.Background(), db, cfg.FilesRoot)
		if err != nil {
			log.Warn().Err(err).Msg("startup storage scrub failed")
			return
		}
		log.Info().
			Int64("deleted", result.DeletedBlobs).
			Int64("freed_bytes", result.FreedBytes).
			Msg("startup storage scrub completed")
	}()
}

func newHTTPServer(s *Server, rdb *goredis.Client, storage *files.Storage) *http.Server {
	davSrv := webdav.NewAuthDAVServer(s.db, s.cfg.FilesRoot, s.auditSvc, s.ioTracker, ratelimit.New(rdb), storage)
	return &http.Server{
		Addr: s.cfg.ListenAddr(),
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/dav/") || r.URL.Path == "/dav" {
				davSrv.ServeHTTP(w, r)
				return
			}
			s.router.ServeHTTP(w, r)
		}),
		ReadHeaderTimeout: 15 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       120 * time.Second,
	}
}

// Start begins serving HTTP requests. Blocks until ctx is cancelled.
func (s *Server) Start(ctx context.Context) error {
	admin.StartScheduler(ctx, s.db, s.cfg.FilesRoot)
	errCh := make(chan error, 1)
	go func() {
		log.Info().Str("addr", s.cfg.ListenAddr()).Msg("HTTP server started")
		if err := s.http.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		log.Info().Msg("shutting down HTTP server")
		return s.http.Shutdown(shutdownCtx)
	case err := <-errCh:
		return fmt.Errorf("HTTP server error: %w", err)
	}
}

func (s *Server) buildRouter() *chi.Mux {
	r := chi.NewRouter()

	// ── Global middleware ──────────────────────────────────────────────────
	r.Use(chimiddleware.Recoverer)
	r.Use(chimiddleware.RequestLogger(redactingLogFormatter{base: &chimiddleware.DefaultLogFormatter{
		Logger: &log.Logger, NoColor: true,
	}}))
	r.Use(mw.RequestID)
	r.Use(mw.RealIP)
	r.Use(mw.SecurityHeaders(mw.InlineScriptHashes(embed.DistFS),
		func() string {
			var v string
			_ = s.db.QueryRow(context.Background(),
				`SELECT value FROM system_settings WHERE key = 'direct_upload_url'`,
			).Scan(&v)
			return v
		},
		func() string {
			var v string
			_ = s.db.QueryRow(context.Background(),
				`SELECT value FROM system_settings WHERE key = 'onlyoffice_url'`,
			).Scan(&v)
			return v
		},
	))
	// M1: Limit JSON request bodies globally to 4 MB. File-upload and backup
	// endpoints apply their own tighter limits via MaxBytesReader, so this
	// global cap only affects small JSON endpoints and prevents large-body DoS.
	// Upload paths are excluded because MaxBytesReader stacks: applying a 4 MB
	// cap here would override the per-user limit set by the upload handlers.
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body != nil &&
				!strings.HasPrefix(r.URL.Path, "/upload/") &&
				!(r.URL.Path == filesUploadRoute && r.Method == http.MethodPost) &&
				r.URL.Path != "/api/v1/backup/buddy/receive" {
				r.Body = http.MaxBytesReader(w, r.Body, 4<<20) // 4 MB
			}
			next.ServeHTTP(w, r)
		})
	})
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins: s.cfg.CORSOrigins,
		AllowedMethods: []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"},
		AllowedHeaders: []string{
			"Accept", "Authorization", contentTypeHeader, "X-Request-ID",
			// Tus resumable-upload protocol headers
			"Tus-Resumable", "Upload-Length", "Upload-Metadata", "Upload-Offset",
			"Upload-Defer-Length", "Upload-Concat",
			// Cross-subdomain upload auth
			"X-Upload-Token",
		},
		ExposedHeaders:   []string{"Location", "Tus-Resumable", "Upload-Offset", "Upload-Length"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// ── System endpoints (no auth required) ───────────────────────────────
	r.Get("/api/v1/system/health", s.handleHealth)
	r.Get("/api/v1/system/version", s.handleVersion)
	r.Get("/api/v1/system/settings", s.adminHandler.GetPublicSettings)
	r.Get("/api/v1/system/onboarding-status", s.onboarding.Status)
	r.Post("/api/v1/system/onboarding", s.onboarding.Setup)
	r.Post("/api/v1/system/onboarding/restore", s.onboarding.RestoreSetup)
	r.Post("/api/v1/system/onboarding/smtp-test", s.onboarding.TestSMTP)
	// Legacy alias used by frontend
	r.Post("/api/v1/setup", s.onboarding.Setup)

	// OnlyOffice document server callbacks (authenticated by JWT, not session)
	r.Post("/api/v1/onlyoffice/callback/{fileId}", s.ooHandler.Callback)
	r.Get("/api/v1/onlyoffice/download/{fileId}", s.ooHandler.Download)

	// ── Auth endpoints (no session required) ──────────────────────────────
	r.Post("/api/v1/auth/login", s.authHandler.Login)
	r.Post("/api/v1/auth/logout", s.authHandler.Logout)
	r.Post("/api/v1/auth/totp/verify", s.authHandler.TOTPVerify)
	r.Post("/api/v1/auth/password-reset/request", s.authHandler.PasswordResetRequest)
	r.Post("/api/v1/auth/password-reset/confirm", s.authHandler.PasswordResetConfirm)
	r.Post("/api/v1/auth/accept-invite", s.handleAcceptInviteRedirect)
	r.Post("/api/v1/invitations/{token}/accept", s.authHandler.AcceptInvite)
	r.Get("/api/v1/invitations/{token}", s.authHandler.GetInviteInfo)

	// ── Public shared-link endpoint (no auth) ─────────────────────────────
	r.Get("/api/v1/public/shared/{token}", s.handleSharedByLink)
	r.Get("/notes/invite/{token}", s.notesHandler.AcceptInvitation)
	r.Get("/api/v1/public/notes/invitations/{token}/accept", s.notesHandler.AcceptInvitation)
	r.Get("/guest/notes/{id}", func(w http.ResponseWriter, request *http.Request) {
		http.Redirect(w, request, "/notes/guest/"+chi.URLParam(request, "id"), http.StatusPermanentRedirect)
	})

	// Note guest sessions are separate from authenticated user sessions.
	r.Get("/api/v1/guest/notes/{id}", s.notesHandler.GuestGet)
	r.Patch("/api/v1/guest/notes/{id}", s.notesHandler.GuestUpdate)
	r.Post("/api/v1/guest/notes/{id}/items", s.notesHandler.GuestCreateItem)
	r.Patch("/api/v1/guest/notes/{id}/items/{itemId}", s.notesHandler.GuestUpdateItem)
	r.Delete("/api/v1/guest/notes/{id}/items/{itemId}", s.notesHandler.GuestDeleteItem)
	r.Post("/api/v1/guest/notes/{id}/items/reorder", s.notesHandler.GuestReorderItems)
	r.Post("/api/v1/guest/logout", s.notesHandler.GuestLogout)

	// ── Public OnlyOffice endpoints for link-share (guest) access ─────────
	r.Get("/api/v1/public/onlyoffice/config/{fileId}", s.ooHandler.PublicGetEditorConfig)
	r.Post("/api/v1/public/onlyoffice/create", s.ooHandler.PublicCreateDocument)
	r.Post("/api/v1/public/files/create-text", s.filesHandler.PublicCreateTextFile)

	// ── Buddy backup public endpoints (no user session) ─────────────────────
	r.Post("/api/v1/backup/buddy/receive", s.backupHandler.BuddyReceive)
	r.Get("/api/v1/backup/buddy/server-info", s.backupHandler.BuddyServerInfo)
	// Sender-archives: lets the pusher list/delete archives stored on this instance using their receive token.
	r.Get("/api/v1/backup/buddy/sender-archives", s.backupHandler.ListSenderArchives)
	r.Delete("/api/v1/backup/buddy/sender-archives/{filename}", s.backupHandler.DeleteSenderArchive) // Reverse-tunnel endpoint: CGNAT peers connect here via WebSocket so this
	// instance can push archives back through the tunnel.
	r.Get("/api/v1/backup/buddy/tunnel", s.backupHandler.BuddyTunnel)
	// ── Authenticated API routes ───────────────────────────────────────────
	r.Group(func(r chi.Router) {
		r.Use(s.authHandler.SessionMiddleware)
		r.Use(mw.RequireAuth)

		// Current user
		r.Get("/api/v1/me", s.authHandler.Me)
		r.Patch("/api/v1/me", s.handleUpdateMe)
		r.Get("/api/v1/me/app-passwords", s.handleListAppPasswords)
		r.Post("/api/v1/me/app-passwords", s.handleCreateAppPassword)
		r.Delete("/api/v1/me/app-passwords/{id}", s.handleRevokeAppPassword)
		r.Get("/api/v1/me/totp/setup", s.handleTOTPSetup)
		r.Post("/api/v1/me/totp/confirm", s.handleTOTPConfirm)
		r.Delete("/api/v1/me/totp", s.handleTOTPDisable)
		r.Get("/api/v1/me/activity", s.adminHandler.UserActivity)
		r.Get("/api/v1/me/playlist-state", s.authHandler.GetPlaylistState)
		r.Put("/api/v1/me/playlist-state", s.authHandler.SavePlaylistState)

		// Upload token (cross-subdomain TUS auth)
		r.Post("/api/v1/upload-token", s.authHandler.HandleIssueUploadToken)

		// Sessions
		r.Get("/api/v1/auth/sessions", s.handleListSessions)
		r.Delete("/api/v1/auth/sessions/{id}", s.handleRevokeSession)

		// Files
		r.Get(filesRoute, s.filesHandler.List)
		r.Post(filesRoute, s.filesHandler.CreateFolder)
		r.Post("/api/v1/files/upload", s.filesHandler.Upload)
		r.Get("/api/v1/files/recent", s.filesHandler.Recent)
		r.Get("/api/v1/files/breadcrumbs", s.filesHandler.Breadcrumbs)
		r.Get("/api/v1/files/search", s.filesHandler.Search)
		r.Get("/api/v1/files/duplicates", s.filesHandler.DuplicateMatches)
		r.Get("/api/v1/files/shared-with-me", s.handleSharedWithMe)
		r.Get("/api/v1/files/my-shares", s.handleMyShares)
		r.Get("/api/v1/files/shared/{id}/children", s.sharesHandler.SharedFolderChildren)
		r.Get("/api/v1/files/trash", s.filesHandler.ListTrash)
		r.Delete("/api/v1/files/trash", s.filesHandler.EmptyTrash)
		r.Get("/api/v1/files/download-zip", s.filesHandler.DownloadZip)
		r.Post("/api/v1/files/prepare-download", s.filesHandler.PrepareDownload)
		r.Get("/api/v1/files/{id}/preview", s.filesHandler.Preview)
		r.Get("/api/v1/files/{id}/preview/pdf", s.filesHandler.PreviewPDF)
		r.Get("/api/v1/files/{id}/thumbnail", s.filesHandler.Thumbnail)
		r.Post("/api/v1/files/playlist", s.filesHandler.CreatePlaylist)
		r.Get("/api/v1/files/{id}/playlist/tracks", s.filesHandler.PlaylistTracks)
		r.Put("/api/v1/files/{id}/playlist/tracks", s.filesHandler.UpdatePlaylist)
		r.Get(fileByIDRoute, s.filesHandler.Get)
		r.Patch(fileByIDRoute, s.filesHandler.Update)
		r.Delete(fileByIDRoute, s.filesHandler.Delete)
		r.Post("/api/v1/files/{id}/copy", s.filesHandler.Copy)
		r.Get("/api/v1/files/{id}/download", s.filesHandler.Download)
		r.Put("/api/v1/files/{id}/content", s.filesHandler.SaveContent)
		r.Post("/api/v1/files/create-text", s.filesHandler.CreateTextFile)
		r.Get("/api/v1/files/{id}/size", s.filesHandler.FolderSize)
		r.Post("/api/v1/files/trash/{id}/restore", s.filesHandler.RestoreTrash)
		r.Delete("/api/v1/files/trash/{id}", s.filesHandler.PermanentDelete)
		r.Post("/api/v1/files/trash/bulk-restore", s.filesHandler.BulkRestoreTrash)
		r.Post("/api/v1/files/trash/bulk-delete", s.filesHandler.BulkPermanentDeleteTrash)

		// Shares
		r.Get("/api/v1/shares", s.handleListShares)
		r.Post("/api/v1/shares", s.handleCreateShare)
		r.Patch("/api/v1/shares/{id}", s.handleUpdateShare)
		r.Delete("/api/v1/shares/{id}", s.handleRevokeShare)

		// Notes
		r.Get("/api/v1/notes", s.notesHandler.List)
		r.Post("/api/v1/notes", s.notesHandler.Create)
		r.Get(noteByIDRoute, s.notesHandler.Get)
		r.Patch(noteByIDRoute, s.notesHandler.Update)
		r.Post("/api/v1/notes/{id}/checklist", s.notesHandler.ConvertToChecklist)
		r.Delete(noteByIDRoute, s.notesHandler.Delete)
		r.Post("/api/v1/notes/{id}/restore", s.notesHandler.Restore)
		r.Delete("/api/v1/notes/{id}/permanent", s.notesHandler.PermanentDelete)
		r.Post("/api/v1/notes/{id}/items", s.notesHandler.CreateItem)
		r.Patch("/api/v1/notes/{id}/items/{itemId}", s.notesHandler.UpdateItem)
		r.Delete("/api/v1/notes/{id}/items/{itemId}", s.notesHandler.DeleteItem)
		r.Post("/api/v1/notes/{id}/items/reorder", s.notesHandler.ReorderItems)
		r.Get("/api/v1/notes/{id}/shares", s.notesHandler.ListShares)
		r.Post("/api/v1/notes/{id}/shares", s.notesHandler.CreateShare)
		r.Patch("/api/v1/notes/{id}/shares/{shareId}", s.notesHandler.UpdateShare)
		r.Delete("/api/v1/notes/{id}/shares/{shareId}", s.notesHandler.RevokeShare)
		r.Post("/api/v1/notes/{id}/shares/{shareId}/resend", s.notesHandler.ResendShare)

		// Backup
		r.Get("/api/v1/backup/config", s.backupHandler.GetConfig)
		r.Get(backupPasswordRoute, s.backupHandler.GetPassword)
		r.Post(backupPasswordRoute, s.backupHandler.GeneratePassword)
		r.Delete(backupPasswordRoute, s.backupHandler.RevokePassword)
		r.Post("/api/v1/backup/export", s.backupHandler.Export)
		r.Post("/api/v1/backup/restore", s.backupHandler.Restore)
		// Tertiary backup (server-side storage)
		r.Post("/api/v1/backup/tertiary", s.backupHandler.StoreTertiary)
		r.Get("/api/v1/backup/tertiary", s.backupHandler.ListTertiary)
		r.Get("/api/v1/backup/tertiary/{filename}", s.backupHandler.DownloadTertiary)
		r.Delete("/api/v1/backup/tertiary/{filename}", s.backupHandler.DeleteTertiary)
		// Auto backup schedule
		r.Get("/api/v1/backup/auto", s.backupHandler.GetAutoConfig)
		r.Put("/api/v1/backup/auto", s.backupHandler.SetAutoConfig)
		// Buddy backup (per-user config + push to peer)
		r.Get(backupBuddyConfigRoute, s.backupHandler.GetBuddyConfig)
		r.Put(backupBuddyConfigRoute, s.backupHandler.SetBuddyPeerConfig)
		r.Delete(backupBuddyConfigRoute, s.backupHandler.ClearBuddyPeerConfig)
		r.Post("/api/v1/backup/buddy/receive-token", s.backupHandler.GenerateBuddyReceiveToken)
		r.Delete("/api/v1/backup/buddy/receive-token", s.backupHandler.RevokeBuddyReceiveToken)
		r.Post("/api/v1/backup/buddy/push", s.backupHandler.BuddyPush)
		r.Get("/api/v1/backup/buddy/push/progress", s.backupHandler.BuddyPushProgress)
		r.Delete("/api/v1/backup/buddy/push-in-progress", s.backupHandler.ResetBuddyPushInProgress)
		r.Put("/api/v1/backup/buddy/auto", s.backupHandler.SetBuddyAutoConfig)
		r.Put("/api/v1/backup/notify", s.backupHandler.SetBackupNotifyConfig)
		r.Put("/api/v1/backup/buddy/quota", s.backupHandler.SetBuddyQuota)
		// Reverse tunnel management (client side — connect this instance to peer's tunnel)
		r.Post("/api/v1/backup/buddy/tunnel/connect", s.backupHandler.BuddyTunnelConnect)
		r.Delete("/api/v1/backup/buddy/tunnel/connect", s.backupHandler.BuddyTunnelDisconnect)
		r.Get("/api/v1/backup/buddy/tunnel/status", s.backupHandler.BuddyTunnelStatus)
		r.Get("/api/v1/backup/buddy/received", s.backupHandler.ListBuddyReceived)
		r.Get("/api/v1/backup/buddy/received/{filename}", s.backupHandler.DownloadBuddyReceived)
		r.Delete("/api/v1/backup/buddy/received/{filename}", s.backupHandler.DeleteBuddyReceived)
		// Pushed: proxy calls to peer to list/delete archives the current user has pushed there.
		r.Get("/api/v1/backup/buddy/pushed", s.backupHandler.ListPushedArchives)
		r.Delete("/api/v1/backup/buddy/pushed/{filename}", s.backupHandler.DeletePushedArchive)

		// SSE (admin-in-account banner)
		r.Get("/api/v1/me/events", s.handleSSE)

		// OnlyOffice editor integration (available to all authenticated users)
		r.Get("/api/v1/onlyoffice/config/{fileId}", s.ooHandler.GetEditorConfig)
		r.Get("/api/v1/onlyoffice/token/{fileId}", s.ooHandler.MakeDownloadToken)
		r.Get("/api/v1/onlyoffice/test", s.ooHandler.Test)
		r.Post("/api/v1/onlyoffice/create", s.ooHandler.CreateDocument)

		// Admin routes
		r.Group(func(r chi.Router) {
			r.Use(mw.RequireAdmin)

			r.Get("/api/v1/admin/users", s.userHandler.List)
			r.Post("/api/v1/admin/users", s.userHandler.Create)
			r.Get(adminUsersByIDRoute, s.userHandler.Get)
			r.Patch(adminUsersByIDRoute, s.userHandler.Update)
			r.Delete(adminUsersByIDRoute, s.userHandler.Delete)
			r.Post("/api/v1/admin/users/{id}/lock", s.userHandler.Lock)
			r.Post("/api/v1/admin/users/{id}/unlock", s.userHandler.Unlock)
			r.Post("/api/v1/admin/users/{id}/force-password-reset", s.userHandler.ForcePasswordReset)
			r.Delete("/api/v1/admin/users/{id}/totp", s.userHandler.RevokeTOTP)
			r.Post("/api/v1/admin/users/{id}/require-totp", s.userHandler.RequireTOTP)
			r.Delete("/api/v1/admin/users/{id}/require-totp", s.userHandler.UnrequireTOTP)
			r.Post("/api/v1/admin/users/{id}/invite", s.handleAdminReinviteUser)
			r.Get("/api/v1/admin/users/{id}/sessions", s.userHandler.ListSessions)
			r.Post("/api/v1/admin/users/{id}/support-access", s.handleAdminSupportAccess)
			r.Post("/api/v1/admin/users/{id}/recalculate-quota", s.userHandler.RecalculateQuota)

			r.Get("/api/v1/admin/guests", s.userHandler.ListGuests)
			r.Post("/api/v1/admin/guests/{id}/promote", s.userHandler.PromoteGuest)
			r.Delete("/api/v1/admin/guests/{id}", s.userHandler.DeleteGuest)

			r.Get("/api/v1/admin/groups", s.handleAdminListGroups)
			r.Post("/api/v1/admin/groups", s.handleAdminCreateGroup)
			r.Patch("/api/v1/admin/groups/{id}", s.handleAdminUpdateGroup)
			r.Delete("/api/v1/admin/groups/{id}", s.handleAdminDeleteGroup)
			r.Get("/api/v1/admin/groups/{id}/members", s.handleAdminListGroupMembers)
			r.Post("/api/v1/admin/groups/{id}/members", s.handleAdminAddGroupMember)
			r.Delete("/api/v1/admin/groups/{id}/members/{userId}", s.handleAdminRemoveGroupMember)

			r.Get("/api/v1/admin/tags", s.handleAdminListTags)
			r.Post("/api/v1/admin/tags", s.handleAdminCreateTag)
			r.Patch("/api/v1/admin/tags/{id}", s.handleAdminUpdateTag)
			r.Delete("/api/v1/admin/tags/{id}", s.handleAdminDeleteTag)

			r.Get("/api/v1/admin/audit-logs", s.handleAdminAuditLogs)
			r.Get("/api/v1/admin/stats", s.handleAdminStats)
			r.Get("/api/v1/admin/blocked-ips", s.handleAdminListBlockedIPs)
			r.Delete("/api/v1/admin/blocked-ips/{ip}", s.handleAdminUnblockIP)
			r.Get("/api/v1/admin/ip-whitelist", s.handleAdminListWhitelist)
			r.Post("/api/v1/admin/ip-whitelist", s.handleAdminAddWhitelist)
			r.Delete("/api/v1/admin/ip-whitelist/{id}", s.handleAdminRemoveWhitelist)

			r.Get("/api/v1/admin/settings", s.handleAdminGetSettings)
			r.Patch("/api/v1/admin/settings", s.handleAdminUpdateSettings)
			r.Post("/api/v1/admin/settings/smtp-test", s.handleAdminSMTPTest)

			r.Get("/api/v1/admin/backup", s.handleAdminListBackups)
			r.Post("/api/v1/admin/backup", s.handleAdminExport)
			r.Post("/api/v1/admin/backup/restore", s.handleAdminImport)
			r.Get("/api/v1/admin/backup/{filename}/download", s.handleAdminDownloadBackup)
			r.Delete("/api/v1/admin/backup/{filename}", s.handleAdminDeleteBackup)

			r.Post("/api/v1/admin/storage/scrub", s.adminHandler.StorageScrub)
			r.Post("/api/v1/admin/storage/scan", s.adminHandler.StorageScan)
			r.Post("/api/v1/admin/storage/purge-corrupt", s.adminHandler.StoragePurgeCorrupt)
			r.Post("/api/v1/admin/storage/scan-orphans", s.adminHandler.StorageScanOrphans)
			r.Post("/api/v1/admin/storage/purge-orphans", s.adminHandler.StoragePurgeOrphans)
			r.Post("/api/v1/admin/storage/restore-orphans", s.adminHandler.StorageRestoreOrphans)
			r.Get("/api/v1/admin/storage/schedule", s.adminHandler.GetScanSchedule)
			r.Put("/api/v1/admin/storage/schedule", s.adminHandler.PutScanSchedule)
			r.Get("/api/v1/admin/io-stats", s.adminHandler.IOStats)

			r.Post("/api/v1/admin/support-access/{id}/end", s.handleAdminEndSupportAccess)
		})
	})

	// ── Tus resumable upload ────────────────────────────────────────────────
	r.Mount("/upload", s.tusHandler())

	// ── SPA fallback — must be last ─────────────────────────────────────────
	r.Mount("/", s.spaHandler())

	return r
}

type redactingLogFormatter struct {
	base chimiddleware.LogFormatter
}

func (formatter redactingLogFormatter) NewLogEntry(request *http.Request) chimiddleware.LogEntry {
	if !strings.HasPrefix(request.URL.Path, "/notes/invite/") &&
		!strings.HasPrefix(request.URL.Path, "/api/v1/public/notes/invitations/") {
		return formatter.base.NewLogEntry(request)
	}
	clone := request.Clone(request.Context())
	clonedURL := *request.URL
	if strings.HasPrefix(request.URL.Path, "/notes/invite/") {
		clonedURL.Path = "/notes/invite/[redacted]"
	} else {
		clonedURL.Path = "/api/v1/public/notes/invitations/[redacted]/accept"
	}
	clonedURL.RawPath = ""
	clone.URL = &clonedURL
	clone.RequestURI = clonedURL.RequestURI()
	return formatter.base.NewLogEntry(clone)
}

// spaHandler serves the embedded React SPA for all non-API routes.
func (s *Server) spaHandler() http.Handler {
	distFS, err := fs.Sub(embed.DistFS, "dist")
	if err != nil {
		panic(fmt.Sprintf("embed: failed to sub dist: %v", err))
	}
	fileServer := http.FileServer(http.FS(distFS))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Serve the actual file if it exists in the embedded FS
		path := strings.TrimPrefix(r.URL.Path, "/")
		if f, err := distFS.Open(path); err == nil {
			f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}
		// Fall through to index.html for client-side routing
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}

// ── Stub handlers — replaced by real implementations as modules are built ──

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	respond(w, http.StatusOK, map[string]any{
		"status": "ok",
		"db":     s.dbStatus(r.Context()),
		"redis":  s.redisStatus(r.Context()),
	})
}

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	respond(w, http.StatusOK, map[string]string{
		"version":    s.version,
		"build_date": s.buildDate,
	})
}

func (s *Server) dbStatus(ctx context.Context) string {
	if err := s.db.Ping(ctx); err != nil {
		return "error"
	}
	return "ok"
}

func (s *Server) redisStatus(ctx context.Context) string {
	if err := s.redis.Ping(ctx).Err(); err != nil {
		return "error"
	}
	return "ok"
}

// cleanPreviewCache removes LibreOffice PDF cache entries older than 24 hours.
func cleanPreviewCache(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	cutoff := time.Now().Add(-24 * time.Hour)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || e.IsDir() {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
	return nil
}

// cleanTusUploadDir removes abandoned partial TUS upload files (.bin and .info)
// that are older than 48 hours. This prevents unbounded disk growth from uploads
// that were never completed or whose sessions were disrupted.
func cleanTusUploadDir(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	cutoff := time.Now().Add(-48 * time.Hour)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		name := e.Name()
		if (strings.HasSuffix(name, ".bin") || strings.HasSuffix(name, ".info")) &&
			info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, name))
		}
	}
	return nil
}

func (s *Server) handleOnboardingStatus(w http.ResponseWriter, r *http.Request) {
	s.onboarding.Status(w, r)
}

// handleAcceptInviteRedirect handles the legacy POST /auth/accept-invite route
// by forwarding to the auth handler's AcceptInvite (token comes from request body).
func (s *Server) handleAcceptInviteRedirect(w http.ResponseWriter, r *http.Request) {
	s.authHandler.AcceptInvite(w, r)
}

// Remaining stub handlers — bodies implemented module by module.
func (s *Server) handleOnboarding(w http.ResponseWriter, r *http.Request) { s.onboarding.Setup(w, r) }
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request)      { s.authHandler.Login(w, r) }
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request)     { s.authHandler.Logout(w, r) }
func (s *Server) handleTOTPVerify(w http.ResponseWriter, r *http.Request) {
	s.authHandler.TOTPVerify(w, r)
}
func (s *Server) handlePasswordResetRequest(w http.ResponseWriter, r *http.Request) {
	s.authHandler.PasswordResetRequest(w, r)
}
func (s *Server) handlePasswordResetConfirm(w http.ResponseWriter, r *http.Request) {
	s.authHandler.PasswordResetConfirm(w, r)
}
func (s *Server) handleAcceptInvite(w http.ResponseWriter, r *http.Request) { s.notImplemented(w) }
func (s *Server) handleGetMe(w http.ResponseWriter, r *http.Request)        { s.authHandler.Me(w, r) }
func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request)     { s.authHandler.UpdateMe(w, r) }
func (s *Server) handleListAppPasswords(w http.ResponseWriter, r *http.Request) {
	s.appPwdHandler.List(w, r)
}
func (s *Server) handleCreateAppPassword(w http.ResponseWriter, r *http.Request) {
	s.appPwdHandler.Create(w, r)
}
func (s *Server) handleRevokeAppPassword(w http.ResponseWriter, r *http.Request) {
	s.appPwdHandler.Revoke(w, r)
}
func (s *Server) handleTOTPSetup(w http.ResponseWriter, r *http.Request) {
	s.authHandler.TOTPSetup(w, r)
}
func (s *Server) handleTOTPConfirm(w http.ResponseWriter, r *http.Request) {
	s.authHandler.TOTPConfirm(w, r)
}
func (s *Server) handleTOTPDisable(w http.ResponseWriter, r *http.Request) {
	s.authHandler.TOTPDisable(w, r)
}
func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	s.authHandler.ListSessions(w, r)
}
func (s *Server) handleRevokeSession(w http.ResponseWriter, r *http.Request) {
	s.authHandler.RevokeSession(w, r)
}
func (s *Server) handleListFiles(w http.ResponseWriter, r *http.Request)    { s.notImplemented(w) }
func (s *Server) handleCreateFolder(w http.ResponseWriter, r *http.Request) { s.notImplemented(w) }
func (s *Server) handleRecentFiles(w http.ResponseWriter, r *http.Request)  { s.notImplemented(w) }
func (s *Server) handleSharedWithMe(w http.ResponseWriter, r *http.Request) {
	s.sharesHandler.SharedWithMe(w, r)
}
func (s *Server) handleMyShares(w http.ResponseWriter, r *http.Request) {
	s.sharesHandler.MyShares(w, r)
}
func (s *Server) handleSharedByLink(w http.ResponseWriter, r *http.Request) {
	s.sharesHandler.SharedByLink(w, r)
}
func (s *Server) handleListTrash(w http.ResponseWriter, r *http.Request)       { s.notImplemented(w) }
func (s *Server) handleGetFile(w http.ResponseWriter, r *http.Request)         { s.notImplemented(w) }
func (s *Server) handleUpdateFile(w http.ResponseWriter, r *http.Request)      { s.notImplemented(w) }
func (s *Server) handleDeleteFile(w http.ResponseWriter, r *http.Request)      { s.notImplemented(w) }
func (s *Server) handleDownloadFile(w http.ResponseWriter, r *http.Request)    { s.notImplemented(w) }
func (s *Server) handleRestoreFile(w http.ResponseWriter, r *http.Request)     { s.notImplemented(w) }
func (s *Server) handlePermanentDelete(w http.ResponseWriter, r *http.Request) { s.notImplemented(w) }
func (s *Server) handleListShares(w http.ResponseWriter, r *http.Request)      { s.sharesHandler.List(w, r) }
func (s *Server) handleCreateShare(w http.ResponseWriter, r *http.Request) {
	s.sharesHandler.Create(w, r)
}
func (s *Server) handleUpdateShare(w http.ResponseWriter, r *http.Request) {
	s.sharesHandler.Update(w, r)
}
func (s *Server) handleRevokeShare(w http.ResponseWriter, r *http.Request) {
	s.sharesHandler.Revoke(w, r)
}
func (s *Server) handleSSE(w http.ResponseWriter, r *http.Request)             { s.sseHandler.Events(w, r) }
func (s *Server) handleAdminListUsers(w http.ResponseWriter, r *http.Request)  { s.notImplemented(w) }
func (s *Server) handleAdminCreateUser(w http.ResponseWriter, r *http.Request) { s.notImplemented(w) }
func (s *Server) handleAdminGetUser(w http.ResponseWriter, r *http.Request)    { s.notImplemented(w) }
func (s *Server) handleAdminUpdateUser(w http.ResponseWriter, r *http.Request) { s.notImplemented(w) }
func (s *Server) handleAdminDeactivateUser(w http.ResponseWriter, r *http.Request) {
	s.notImplemented(w)
}
func (s *Server) handleAdminReinviteUser(w http.ResponseWriter, r *http.Request) {
	s.userHandler.Reinvite(w, r)
}
func (s *Server) handleAdminListUserSessions(w http.ResponseWriter, r *http.Request) {
	s.notImplemented(w)
}
func (s *Server) handleAdminSupportAccess(w http.ResponseWriter, r *http.Request) {
	s.supportHandler.Begin(w, r)
}
func (s *Server) handleAdminListGroups(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.ListGroups(w, r)
}
func (s *Server) handleAdminCreateGroup(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.CreateGroup(w, r)
}
func (s *Server) handleAdminUpdateGroup(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.UpdateGroup(w, r)
}
func (s *Server) handleAdminDeleteGroup(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.DeleteGroup(w, r)
}
func (s *Server) handleAdminListGroupMembers(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.ListGroupMembers(w, r)
}
func (s *Server) handleAdminAddGroupMember(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.AddGroupMember(w, r)
}
func (s *Server) handleAdminRemoveGroupMember(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.RemoveGroupMember(w, r)
}
func (s *Server) handleAdminListTags(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.ListTags(w, r)
}
func (s *Server) handleAdminCreateTag(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.CreateTag(w, r)
}
func (s *Server) handleAdminUpdateTag(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.UpdateTag(w, r)
}
func (s *Server) handleAdminDeleteTag(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.DeleteTag(w, r)
}
func (s *Server) handleAdminAuditLogs(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.AuditLogs(w, r)
}
func (s *Server) handleAdminStats(w http.ResponseWriter, r *http.Request) { s.adminHandler.Stats(w, r) }
func (s *Server) handleAdminListBlockedIPs(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.ListBlockedIPs(w, r)
}
func (s *Server) handleAdminUnblockIP(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.UnblockIP(w, r)
}
func (s *Server) handleAdminListWhitelist(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.ListWhitelist(w, r)
}
func (s *Server) handleAdminAddWhitelist(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.AddWhitelist(w, r)
}
func (s *Server) handleAdminRemoveWhitelist(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.RemoveWhitelist(w, r)
}
func (s *Server) handleAdminGetSettings(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.GetSettings(w, r)
}
func (s *Server) handleAdminUpdateSettings(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.UpdateSettings(w, r)
}
func (s *Server) handleAdminSMTPTest(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.SMTPTest(w, r)
}
func (s *Server) handleAdminListBackups(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.ListBackups(w, r)
}
func (s *Server) handleAdminExport(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.Export(w, r)
}
func (s *Server) handleAdminImport(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.Import(w, r)
}
func (s *Server) handleAdminDownloadBackup(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.DownloadBackup(w, r)
}
func (s *Server) handleAdminDeleteBackup(w http.ResponseWriter, r *http.Request) {
	s.adminHandler.DeleteBackup(w, r)
}
func (s *Server) handleAdminEndSupportAccess(w http.ResponseWriter, r *http.Request) {
	s.supportHandler.End(w, r)
}

func (s *Server) sessionMiddleware(next http.Handler) http.Handler {
	// This is no longer called — s.authHandler.SessionMiddleware is used directly.
	// Kept as dead code guard to avoid naming conflicts if referenced elsewhere.
	return s.authHandler.SessionMiddleware(next)
}

func (s *Server) tusHandler() http.Handler {
	if err := os.MkdirAll(s.cfg.TusUploadDir, 0750); err != nil {
		log.Fatal().Err(err).Str("dir", s.cfg.TusUploadDir).Msg("tusHandler: mkdir")
	}

	store := filestore.New(s.cfg.TusUploadDir)
	composer := tusd.NewStoreComposer()
	store.UseIn(composer)

	tusConfig := tusd.Config{
		BasePath:                  "/upload/",
		StoreComposer:             composer,
		RespectForwardedHeaders:   true,
		PreUploadCreateCallback:   s.tusPreUploadCreateCallback,
		PreFinishResponseCallback: s.tusPreFinishResponseCallback,
	}

	h, err := tusd.NewUnroutedHandler(tusConfig)
	if err != nil {
		log.Fatal().Err(err).Msg("tusHandler: NewUnroutedHandler")
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler { return http.StripPrefix("/upload", next) })
	r.Options("/", http.HandlerFunc(writeTusNoContent))
	r.Options("/{id}", http.HandlerFunc(writeTusNoContent))

	r.Group(func(r chi.Router) {
		r.Use(s.authHandler.SessionMiddleware)
		r.Use(s.authHandler.UploadTokenMiddleware)
		r.Use(mw.RequireAuth)
		r.Use(h.Middleware)
		r.Use(s.tusTrackPatchUploadMiddleware)
		r.Post("/", h.PostFile)
		r.Head("/{id}", h.HeadFile)
		r.Patch("/{id}", h.PatchFile)
		r.Delete("/{id}", h.DelFile)
	})
	return r
}

func writeTusNoContent(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) tusPreUploadCreateCallback(hook tusd.HookEvent) (tusd.HTTPResponse, tusd.FileInfoChanges, error) {
	ctx := hook.Context
	actor := mw.UserFromContext(ctx)
	if actor == nil {
		return tusd.HTTPResponse{StatusCode: http.StatusUnauthorized}, tusd.FileInfoChanges{}, nil
	}

	meta := hook.Upload.MetaData
	overwrite := isTusOverwrite(meta)
	conflict, response := s.tusFindUploadConflict(ctx, meta, overwrite)
	if response != nil {
		return *response, tusd.FileInfoChanges{}, nil
	}
	if response := s.tusValidateUploadSize(ctx, actor, hook.Upload.Size, tusFolderID(meta), overwrite, conflict); response != nil {
		return *response, tusd.FileInfoChanges{}, nil
	}

	return tusd.HTTPResponse{}, tusd.FileInfoChanges{}, nil
}

func isTusOverwrite(meta map[string]string) bool {
	return strings.EqualFold(strings.TrimSpace(meta["overwrite"]), "1") || strings.EqualFold(strings.TrimSpace(meta["overwrite"]), "true")
}

func (s *Server) tusFindUploadConflict(ctx context.Context, meta map[string]string, overwrite bool) (*files.File, *tusd.HTTPResponse) {
	name := strings.TrimSpace(meta["filename"])
	if name == "" {
		return nil, nil
	}

	found, err := s.fileSvc.FindNameConflict(ctx, name, tusFolderID(meta))
	if err != nil {
		log.Error().Err(err).Msg("tusHandler: precreate conflict lookup")
		response := tusd.HTTPResponse{StatusCode: http.StatusInternalServerError}
		return nil, &response
	}
	if found == nil {
		return nil, nil
	}
	if found.IsFolder || !overwrite {
		response := tusUploadConflictResponse(found.IsFolder)
		return nil, &response
	}

	return found, nil
}

func tusUploadConflictResponse(isFolder bool) tusd.HTTPResponse {
	message := "a file with this name already exists"
	if isFolder {
		message = "a folder with this name already exists"
	}
	return tusUploadErrorResponse(http.StatusConflict, message)
}

func (s *Server) tusValidateUploadSize(ctx context.Context, actor *user.User, size int64, folderID string, overwrite bool, conflict *files.File) *tusd.HTTPResponse {
	if size <= 0 {
		return nil
	}

	maxBytes := s.fileSvc.GetEffectiveMaxUpload(ctx, actor.ID.String(), actor.Role, folderID)
	if size > maxBytes {
		response := tusUploadErrorResponse(http.StatusRequestEntityTooLarge, "file exceeds the maximum upload size for this account")
		return &response
	}
	if !overwrite || conflict == nil {
		if err := s.fileSvc.CheckQuota(ctx, actor.ID.String(), size); err != nil {
			response := tusUploadErrorResponse(http.StatusUnprocessableEntity, err.Error())
			return &response
		}
	}

	return nil
}

func (s *Server) tusPreFinishResponseCallback(hook tusd.HookEvent) (tusd.HTTPResponse, error) {
	ctx := hook.Context
	actor := mw.UserFromContext(ctx)
	if actor == nil {
		return tusd.HTTPResponse{StatusCode: http.StatusUnauthorized}, nil
	}

	name, mimeType, folderID, overwrite := normalizeTusFinalizeMeta(hook.Upload.MetaData)
	tempPath := filepath.Join(s.cfg.TusUploadDir, hook.Upload.ID)
	params := files.UploadParams{
		OwnerID:       actor.ID.String(),
		Name:          name,
		MimeType:      mimeType,
		FolderID:      folderID,
		Overwrite:     overwrite,
		ContentLength: hook.Upload.Size,
	}

	file, err := s.fileSvc.FinalizeTusUpload(ctx, tempPath, params)
	if err != nil {
		log.Error().Err(err).Str("upload_id", hook.Upload.ID).Msg("tusHandler: finalize")
		return tusFinalizeUploadErrorResponse(err), err
	}

	s.auditSvc.Log(ctx, audit.Event{
		Type:         audit.EventFileUploaded,
		ActorID:      &actor.ID,
		ResourceID:   &file.ID,
		ResourceName: file.Name,
		IPAddress:    hook.HTTPRequest.RemoteAddr,
	})
	return tusd.HTTPResponse{}, nil
}

func normalizeTusFinalizeMeta(meta map[string]string) (string, string, string, bool) {
	name := meta["filename"]
	if name == "" {
		name = "upload"
	}
	mimeType := meta["filetype"]
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return name, mimeType, tusFolderID(meta), isTusOverwrite(meta)
}

// tusFolderID accepts both metadata names used by Sharedrive clients.
// Current clients send folder_id. Older installed PWAs used parent_id and can
// remain active until Android refreshes the service worker and hashed assets.
func tusFolderID(meta map[string]string) string {
	if folderID := strings.TrimSpace(meta["folder_id"]); folderID != "" {
		return folderID
	}
	return strings.TrimSpace(meta["parent_id"])
}

func tusFinalizeUploadErrorResponse(err error) tusd.HTTPResponse {
	code := http.StatusInternalServerError
	if strings.HasPrefix(err.Error(), "quota:") {
		code = http.StatusUnprocessableEntity
	}
	var conflictErr *files.UploadConflictError
	if errors.As(err, &conflictErr) {
		code = http.StatusConflict
	}
	return tusUploadErrorResponse(code, err.Error())
}

func tusUploadErrorResponse(statusCode int, message string) tusd.HTTPResponse {
	return tusd.HTTPResponse{
		StatusCode: statusCode,
		Body:       `{"error":"` + message + `"}`,
		Header:     tusd.HTTPHeader{contentTypeHeader: jsonContentType},
	}
}

func (s *Server) tusTrackPatchUploadMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			s.trackTusPatchUpload(r)
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) trackTusPatchUpload(r *http.Request) {
	actor := mw.UserFromContext(r.Context())
	if actor == nil {
		return
	}
	contentLength := r.Header.Get("Content-Length")
	if contentLength == "" {
		return
	}
	bytes, err := strconv.ParseInt(contentLength, 10, 64)
	if err != nil || bytes <= 0 {
		return
	}
	go s.ioTracker.TrackUpload(context.Background(), actor.ID.String(), bytes)
}

func (s *Server) notImplemented(w http.ResponseWriter) {
	respondError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "This endpoint is not yet implemented.")
}

// backupsRoot returns the tertiary backup root path (for 3-2-1 / external-drive backups)
// only if the directory is actually mounted and accessible; otherwise returns "" to
// disable tertiary storage.
// If BACKUPS_ROOT is not configured, /mnt/backup is tried as a convention —
// this is the container path used in the Unraid template Path config.
func backupsRoot(configured string) string {
	candidates := []string{configured, "/mnt/backup"}
	for _, p := range candidates {
		if p == "" {
			continue
		}
		info, err := os.Stat(p)
		if err == nil && info.IsDir() {
			log.Info().Str("path", p).Msg("backups root: using path")
			return p
		}
	}
	return ""
}

// buddyStorageRoot returns the path used to store buddy-received archives.
// It is independent of the tertiary BACKUPS_ROOT so that buddy backup works
// even when no external drive is configured for 3-2-1 backups.
// Priority: BACKUPS_ROOT (if set and accessible) → /data/backups (always mounted
// in the standard Docker setup) → a "buddy" sub-dir next to FILES_ROOT.
func buddyStorageRoot(backupsRootCfg, filesRoot string) string {
	// If the user explicitly set BACKUPS_ROOT and it is accessible, honour it
	// so that buddy archives land on the same volume as tertiary backups.
	if backupsRootCfg != "" {
		if info, err := os.Stat(backupsRootCfg); err == nil && info.IsDir() {
			return backupsRootCfg
		}
	}
	// Standard Docker container path — always mounted via the backups volume.
	if info, err := os.Stat(backupsDataRoot); err == nil && info.IsDir() {
		log.Info().Str("path", backupsDataRoot).Msg("buddy storage root: using /data/backups")
		return backupsDataRoot
	}
	// Last resort: a sibling directory of FILES_ROOT.
	if filesRoot != "" {
		p := filepath.Join(filepath.Dir(filesRoot), "buddy")
		if err := os.MkdirAll(p, 0750); err == nil {
			log.Info().Str("path", p).Msg("buddy storage root: using files sibling")
			return p
		}
	}
	log.Warn().Msg("buddy storage root: no writable path found — buddy backup disabled")
	return ""
}
