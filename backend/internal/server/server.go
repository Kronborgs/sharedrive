package server

import (
	"context"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"
	tusd "github.com/tus/tusd/v2/pkg/handler"
	"github.com/tus/tusd/v2/pkg/filestore"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/admin"
	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/auth"

	"github.com/yourname/privatedrive/internal/config"
	"github.com/yourname/privatedrive/internal/embed"
	"github.com/yourname/privatedrive/internal/files"
	mw "github.com/yourname/privatedrive/internal/middleware"
	"github.com/yourname/privatedrive/internal/onboarding"
	"github.com/yourname/privatedrive/internal/shares"
	"github.com/yourname/privatedrive/internal/smtp"
	"github.com/yourname/privatedrive/internal/user"
	"github.com/yourname/privatedrive/internal/webdav"
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
	adminHandler   *admin.Handler
	sseHandler     *admin.SSEHandler
	supportHandler *admin.SupportAccessHandler
	appPwdHandler  *webdav.AppPasswordHandler
	auditSvc       audit.Logger
}

// New constructs a Server with all routes and middleware registered.
func New(cfg *config.Config, db *pgxpool.Pool, rdb *goredis.Client, authHandler *auth.Handler, auditSvc audit.Logger, version, buildDate string) *Server {
	storage := files.NewStorage(cfg.FilesRoot)
	fileSvc := files.NewService(db, storage)
	trashSvc := files.NewTrashService(db, storage)

	s := &Server{
		cfg:            cfg,
		db:             db,
		redis:          rdb,
		version:        version,
		buildDate:      buildDate,
		authHandler:    authHandler,
		onboarding:     onboarding.New(db, cfg),
		userHandler:    user.NewHandler(db, auditSvc, smtp.New(cfg, db), cfg.AppBaseURL),
		fileSvc:        fileSvc,
		filesHandler:   files.NewHandler(fileSvc, trashSvc, auditSvc),
		sharesHandler:  shares.NewHandler(db, smtp.New(cfg, db), cfg.AppBaseURL),
		adminHandler:   admin.NewHandler(db, cfg),
		sseHandler:     admin.NewSSEHandler(db),
		supportHandler: admin.NewSupportAccessHandler(db),
		appPwdHandler:  webdav.NewAppPasswordHandler(db),
		auditSvc:       auditSvc,
	}
	s.router = s.buildRouter()
	s.http = &http.Server{
		Addr:              cfg.ListenAddr(),
		Handler:           s.router,
		ReadHeaderTimeout: 15 * time.Second, // guards against slow-header attacks
		WriteTimeout:      0,                // disabled; large up/downloads need unbounded time
		IdleTimeout:       120 * time.Second,
	}
	return s
}

// Start begins serving HTTP requests. Blocks until ctx is cancelled.
func (s *Server) Start(ctx context.Context) error {
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
	r.Use(chimiddleware.RequestLogger(&chimiddleware.DefaultLogFormatter{
		Logger: &log.Logger, NoColor: true,
	}))
	r.Use(mw.RequestID)
	r.Use(mw.RealIP)
	r.Use(mw.SecurityHeaders(mw.InlineScriptHashes(embed.DistFS), func() string {
		var v string
		_ = s.db.QueryRow(context.Background(),
			`SELECT value FROM system_settings WHERE key = 'direct_upload_url'`,
		).Scan(&v)
		return v
	}))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   s.cfg.CORSOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"},
		AllowedHeaders: []string{
			"Accept", "Authorization", "Content-Type", "X-Request-ID",
			// Tus resumable-upload protocol headers
			"Tus-Resumable", "Upload-Length", "Upload-Metadata", "Upload-Offset",
			"Upload-Defer-Length", "Upload-Concat",
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

		// Sessions
		r.Get("/api/v1/auth/sessions", s.handleListSessions)
		r.Delete("/api/v1/auth/sessions/{id}", s.handleRevokeSession)

		// Files
		r.Get("/api/v1/files", s.filesHandler.List)
		r.Post("/api/v1/files", s.filesHandler.CreateFolder)
		r.Post("/api/v1/files/upload", s.filesHandler.Upload)
		r.Get("/api/v1/files/recent", s.filesHandler.Recent)
		r.Get("/api/v1/files/breadcrumbs", s.filesHandler.Breadcrumbs)
		r.Get("/api/v1/files/shared-with-me", s.handleSharedWithMe)
		r.Get("/api/v1/files/shared/{id}/children", s.sharesHandler.SharedFolderChildren)
		r.Get("/api/v1/files/trash", s.filesHandler.ListTrash)
		r.Delete("/api/v1/files/trash", s.filesHandler.EmptyTrash)
		r.Get("/api/v1/files/download-zip", s.filesHandler.DownloadZip)
		r.Get("/api/v1/files/{id}", s.filesHandler.Get)
		r.Patch("/api/v1/files/{id}", s.filesHandler.Update)
		r.Delete("/api/v1/files/{id}", s.filesHandler.Delete)
		r.Get("/api/v1/files/{id}/download", s.filesHandler.Download)
		r.Post("/api/v1/files/trash/{id}/restore", s.filesHandler.RestoreTrash)
		r.Delete("/api/v1/files/trash/{id}", s.filesHandler.PermanentDelete)

		// Shares
		r.Get("/api/v1/shares", s.handleListShares)
		r.Post("/api/v1/shares", s.handleCreateShare)
		r.Patch("/api/v1/shares/{id}", s.handleUpdateShare)
		r.Delete("/api/v1/shares/{id}", s.handleRevokeShare)

		// SSE (admin-in-account banner)
		r.Get("/api/v1/me/events", s.handleSSE)

		// Admin routes
		r.Group(func(r chi.Router) {
			r.Use(mw.RequireAdmin)

			r.Get("/api/v1/admin/users", s.userHandler.List)
			r.Post("/api/v1/admin/users", s.userHandler.Create)
			r.Get("/api/v1/admin/users/{id}", s.userHandler.Get)
			r.Patch("/api/v1/admin/users/{id}", s.userHandler.Update)
			r.Delete("/api/v1/admin/users/{id}", s.userHandler.Delete)
			r.Post("/api/v1/admin/users/{id}/lock", s.userHandler.Lock)
			r.Post("/api/v1/admin/users/{id}/unlock", s.userHandler.Unlock)
			r.Post("/api/v1/admin/users/{id}/force-password-reset", s.userHandler.ForcePasswordReset)
			r.Post("/api/v1/admin/users/{id}/invite", s.handleAdminReinviteUser)
			r.Get("/api/v1/admin/users/{id}/sessions", s.userHandler.ListSessions)
			r.Post("/api/v1/admin/users/{id}/support-access", s.handleAdminSupportAccess)

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

			r.Post("/api/v1/admin/support-access/{id}/end", s.handleAdminEndSupportAccess)
		})
	})

	// ── WebDAV ──────────────────────────────────────────────────────────────
	r.Mount("/dav", s.webdavHandler())

	// ── Tus resumable upload ────────────────────────────────────────────────
	r.Mount("/upload", s.tusHandler())

	// ── SPA fallback — must be last ─────────────────────────────────────────
	r.Mount("/", s.spaHandler())

	return r
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

func (s *Server) handleOnboardingStatus(w http.ResponseWriter, r *http.Request) {
	s.onboarding.Status(w, r)
}

// handleAcceptInviteRedirect handles the legacy POST /auth/accept-invite route
// by forwarding to the auth handler's AcceptInvite (token comes from request body).
func (s *Server) handleAcceptInviteRedirect(w http.ResponseWriter, r *http.Request) {
	s.authHandler.AcceptInvite(w, r)
}

// Remaining stub handlers — bodies implemented module by module.
func (s *Server) handleOnboarding(w http.ResponseWriter, r *http.Request)            { s.onboarding.Setup(w, r) }
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request)                  { s.authHandler.Login(w, r) }
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request)                 { s.authHandler.Logout(w, r) }
func (s *Server) handleTOTPVerify(w http.ResponseWriter, r *http.Request)             { s.authHandler.TOTPVerify(w, r) }
func (s *Server) handlePasswordResetRequest(w http.ResponseWriter, r *http.Request)   { s.authHandler.PasswordResetRequest(w, r) }
func (s *Server) handlePasswordResetConfirm(w http.ResponseWriter, r *http.Request)   { s.authHandler.PasswordResetConfirm(w, r) }
func (s *Server) handleAcceptInvite(w http.ResponseWriter, r *http.Request)           { s.notImplemented(w) }
func (s *Server) handleGetMe(w http.ResponseWriter, r *http.Request)                  { s.authHandler.Me(w, r) }
func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request)               { s.authHandler.UpdateMe(w, r) }
func (s *Server) handleListAppPasswords(w http.ResponseWriter, r *http.Request)       { s.appPwdHandler.List(w, r) }
func (s *Server) handleCreateAppPassword(w http.ResponseWriter, r *http.Request)      { s.appPwdHandler.Create(w, r) }
func (s *Server) handleRevokeAppPassword(w http.ResponseWriter, r *http.Request)      { s.appPwdHandler.Revoke(w, r) }
func (s *Server) handleTOTPSetup(w http.ResponseWriter, r *http.Request)              { s.authHandler.TOTPSetup(w, r) }
func (s *Server) handleTOTPConfirm(w http.ResponseWriter, r *http.Request)            { s.authHandler.TOTPConfirm(w, r) }
func (s *Server) handleTOTPDisable(w http.ResponseWriter, r *http.Request)            { s.authHandler.TOTPDisable(w, r) }
func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request)           { s.authHandler.ListSessions(w, r) }
func (s *Server) handleRevokeSession(w http.ResponseWriter, r *http.Request)          { s.authHandler.RevokeSession(w, r) }
func (s *Server) handleListFiles(w http.ResponseWriter, r *http.Request)              { s.notImplemented(w) }
func (s *Server) handleCreateFolder(w http.ResponseWriter, r *http.Request)           { s.notImplemented(w) }
func (s *Server) handleRecentFiles(w http.ResponseWriter, r *http.Request)            { s.notImplemented(w) }
func (s *Server) handleSharedWithMe(w http.ResponseWriter, r *http.Request)           { s.sharesHandler.SharedWithMe(w, r) }
func (s *Server) handleSharedByLink(w http.ResponseWriter, r *http.Request)            { s.sharesHandler.SharedByLink(w, r) }
func (s *Server) handleListTrash(w http.ResponseWriter, r *http.Request)              { s.notImplemented(w) }
func (s *Server) handleGetFile(w http.ResponseWriter, r *http.Request)                { s.notImplemented(w) }
func (s *Server) handleUpdateFile(w http.ResponseWriter, r *http.Request)             { s.notImplemented(w) }
func (s *Server) handleDeleteFile(w http.ResponseWriter, r *http.Request)             { s.notImplemented(w) }
func (s *Server) handleDownloadFile(w http.ResponseWriter, r *http.Request)           { s.notImplemented(w) }
func (s *Server) handleRestoreFile(w http.ResponseWriter, r *http.Request)            { s.notImplemented(w) }
func (s *Server) handlePermanentDelete(w http.ResponseWriter, r *http.Request)        { s.notImplemented(w) }
func (s *Server) handleListShares(w http.ResponseWriter, r *http.Request)             { s.sharesHandler.List(w, r) }
func (s *Server) handleCreateShare(w http.ResponseWriter, r *http.Request)            { s.sharesHandler.Create(w, r) }
func (s *Server) handleUpdateShare(w http.ResponseWriter, r *http.Request)            { s.sharesHandler.Update(w, r) }
func (s *Server) handleRevokeShare(w http.ResponseWriter, r *http.Request)            { s.sharesHandler.Revoke(w, r) }
func (s *Server) handleSSE(w http.ResponseWriter, r *http.Request)                    { s.sseHandler.Events(w, r) }
func (s *Server) handleAdminListUsers(w http.ResponseWriter, r *http.Request)         { s.notImplemented(w) }
func (s *Server) handleAdminCreateUser(w http.ResponseWriter, r *http.Request)        { s.notImplemented(w) }
func (s *Server) handleAdminGetUser(w http.ResponseWriter, r *http.Request)           { s.notImplemented(w) }
func (s *Server) handleAdminUpdateUser(w http.ResponseWriter, r *http.Request)        { s.notImplemented(w) }
func (s *Server) handleAdminDeactivateUser(w http.ResponseWriter, r *http.Request)    { s.notImplemented(w) }
func (s *Server) handleAdminReinviteUser(w http.ResponseWriter, r *http.Request)      { s.userHandler.Reinvite(w, r) }
func (s *Server) handleAdminListUserSessions(w http.ResponseWriter, r *http.Request)  { s.notImplemented(w) }
func (s *Server) handleAdminSupportAccess(w http.ResponseWriter, r *http.Request)     { s.supportHandler.Begin(w, r) }
func (s *Server) handleAdminListGroups(w http.ResponseWriter, r *http.Request)        { s.adminHandler.ListGroups(w, r) }
func (s *Server) handleAdminCreateGroup(w http.ResponseWriter, r *http.Request)       { s.adminHandler.CreateGroup(w, r) }
func (s *Server) handleAdminUpdateGroup(w http.ResponseWriter, r *http.Request)       { s.adminHandler.UpdateGroup(w, r) }
func (s *Server) handleAdminDeleteGroup(w http.ResponseWriter, r *http.Request)       { s.adminHandler.DeleteGroup(w, r) }
func (s *Server) handleAdminListGroupMembers(w http.ResponseWriter, r *http.Request)  { s.adminHandler.ListGroupMembers(w, r) }
func (s *Server) handleAdminAddGroupMember(w http.ResponseWriter, r *http.Request)    { s.adminHandler.AddGroupMember(w, r) }
func (s *Server) handleAdminRemoveGroupMember(w http.ResponseWriter, r *http.Request) { s.adminHandler.RemoveGroupMember(w, r) }
func (s *Server) handleAdminListTags(w http.ResponseWriter, r *http.Request)          { s.adminHandler.ListTags(w, r) }
func (s *Server) handleAdminCreateTag(w http.ResponseWriter, r *http.Request)         { s.adminHandler.CreateTag(w, r) }
func (s *Server) handleAdminUpdateTag(w http.ResponseWriter, r *http.Request)         { s.adminHandler.UpdateTag(w, r) }
func (s *Server) handleAdminDeleteTag(w http.ResponseWriter, r *http.Request)         { s.adminHandler.DeleteTag(w, r) }
func (s *Server) handleAdminAuditLogs(w http.ResponseWriter, r *http.Request)         { s.adminHandler.AuditLogs(w, r) }
func (s *Server) handleAdminStats(w http.ResponseWriter, r *http.Request)              { s.adminHandler.Stats(w, r) }
func (s *Server) handleAdminListBlockedIPs(w http.ResponseWriter, r *http.Request)    { s.adminHandler.ListBlockedIPs(w, r) }
func (s *Server) handleAdminUnblockIP(w http.ResponseWriter, r *http.Request)         { s.adminHandler.UnblockIP(w, r) }
func (s *Server) handleAdminListWhitelist(w http.ResponseWriter, r *http.Request)     { s.adminHandler.ListWhitelist(w, r) }
func (s *Server) handleAdminAddWhitelist(w http.ResponseWriter, r *http.Request)      { s.adminHandler.AddWhitelist(w, r) }
func (s *Server) handleAdminRemoveWhitelist(w http.ResponseWriter, r *http.Request)   { s.adminHandler.RemoveWhitelist(w, r) }
func (s *Server) handleAdminGetSettings(w http.ResponseWriter, r *http.Request)       { s.adminHandler.GetSettings(w, r) }
func (s *Server) handleAdminUpdateSettings(w http.ResponseWriter, r *http.Request)    { s.adminHandler.UpdateSettings(w, r) }
func (s *Server) handleAdminSMTPTest(w http.ResponseWriter, r *http.Request)          { s.adminHandler.SMTPTest(w, r) }
func (s *Server) handleAdminListBackups(w http.ResponseWriter, r *http.Request)        { s.adminHandler.ListBackups(w, r) }
func (s *Server) handleAdminExport(w http.ResponseWriter, r *http.Request)            { s.adminHandler.Export(w, r) }
func (s *Server) handleAdminImport(w http.ResponseWriter, r *http.Request)            { s.adminHandler.Import(w, r) }
func (s *Server) handleAdminEndSupportAccess(w http.ResponseWriter, r *http.Request)  { s.supportHandler.End(w, r) }

func (s *Server) sessionMiddleware(next http.Handler) http.Handler {
	// This is no longer called — s.authHandler.SessionMiddleware is used directly.
	// Kept as dead code guard to avoid naming conflicts if referenced elsewhere.
	return s.authHandler.SessionMiddleware(next)
}

func (s *Server) webdavHandler() http.Handler {
	// TODO: mounted by webdav module
	return http.NotFoundHandler()
}

func (s *Server) tusHandler() http.Handler {
	if err := os.MkdirAll(s.cfg.TusUploadDir, 0750); err != nil {
		log.Fatal().Err(err).Str("dir", s.cfg.TusUploadDir).Msg("tusHandler: mkdir")
	}

	store := filestore.New(s.cfg.TusUploadDir)
	composer := tusd.NewStoreComposer()
	store.UseIn(composer)

	tusConfig := tusd.Config{
		BasePath:                "/upload/",
		StoreComposer:           composer,
		RespectForwardedHeaders: true,
		PreUploadCreateCallback: func(hook tusd.HookEvent) (tusd.HTTPResponse, tusd.FileInfoChanges, error) {
			ctx := hook.Context
			actor := mw.UserFromContext(ctx)
			if actor == nil {
				return tusd.HTTPResponse{StatusCode: http.StatusUnauthorized}, tusd.FileInfoChanges{}, nil
			}
			if hook.Upload.Size > 0 {
				// Enforce per-user (or folder-owner for guests) max upload size
				maxBytes := s.fileSvc.GetEffectiveMaxUpload(ctx, actor.ID.String(), actor.Role, hook.Upload.MetaData["folder_id"])
				if hook.Upload.Size > maxBytes {
					return tusd.HTTPResponse{
						StatusCode: http.StatusRequestEntityTooLarge,
						Body:       `{"error":"file exceeds the maximum upload size for this account"}`,
						Header:     tusd.HTTPHeader{"Content-Type": "application/json"},
					}, tusd.FileInfoChanges{}, nil
				}
				if err := s.fileSvc.CheckQuota(ctx, actor.ID.String(), hook.Upload.Size); err != nil {
					return tusd.HTTPResponse{
						StatusCode: http.StatusUnprocessableEntity,
						Body:       `{"error":"` + err.Error() + `"}`,
						Header:     tusd.HTTPHeader{"Content-Type": "application/json"},
					}, tusd.FileInfoChanges{}, nil
				}
			}
			return tusd.HTTPResponse{}, tusd.FileInfoChanges{}, nil
		},
		PreFinishResponseCallback: func(hook tusd.HookEvent) (tusd.HTTPResponse, error) {
			ctx := hook.Context
			actor := mw.UserFromContext(ctx)
			if actor == nil {
				return tusd.HTTPResponse{StatusCode: http.StatusUnauthorized}, nil
			}
			meta := hook.Upload.MetaData
			name := meta["filename"]
			if name == "" {
				name = "upload"
			}
			mimeType := meta["filetype"]
			if mimeType == "" {
				mimeType = "application/octet-stream"
			}
			folderID := meta["folder_id"]
			tempPath := filepath.Join(s.cfg.TusUploadDir, hook.Upload.ID)

			f, err := s.fileSvc.FinalizeTusUpload(ctx, tempPath, actor.ID.String(), name, mimeType, folderID, hook.Upload.Size)
			if err != nil {
				log.Error().Err(err).Str("upload_id", hook.Upload.ID).Msg("tusHandler: finalize")
				code := http.StatusInternalServerError
				if strings.HasPrefix(err.Error(), "quota:") {
					code = http.StatusUnprocessableEntity
				}
				return tusd.HTTPResponse{
					StatusCode: code,
					Body:       `{"error":"` + err.Error() + `"}`,
					Header:     tusd.HTTPHeader{"Content-Type": "application/json"},
				}, err
			}
			s.auditSvc.Log(ctx, audit.Event{
				Type:         audit.EventFileUploaded,
				ActorID:      &actor.ID,
				ResourceID:   &f.ID,
				ResourceName: f.Name,
			})
			return tusd.HTTPResponse{}, nil
		},
	}

	h, err := tusd.NewUnroutedHandler(tusConfig)
	if err != nil {
		log.Fatal().Err(err).Msg("tusHandler: NewUnroutedHandler")
	}

	r := chi.NewRouter()
	// chi.Mount does NOT strip r.URL.Path (only sets the internal RoutePath).
	// tusd's extractIDFromPath uses strings.Trim(r.URL.Path, "/"), so a PATCH
	// to /upload/{id} would yield "upload/{id}" instead of "{id}" without this.
	r.Use(func(next http.Handler) http.Handler { return http.StripPrefix("/upload", next) })
	r.Use(s.authHandler.SessionMiddleware)
	r.Use(mw.RequireAuth)
	r.Use(h.Middleware)
	r.Post("/", h.PostFile)
	r.Head("/{id}", h.HeadFile)
	r.Patch("/{id}", h.PatchFile)
	r.Delete("/{id}", h.DelFile)
	return r
}

func (s *Server) notImplemented(w http.ResponseWriter) {
	respondError(w, http.StatusNotImplemented, "NOT_IMPLEMENTED", "This endpoint is not yet implemented.")
}
