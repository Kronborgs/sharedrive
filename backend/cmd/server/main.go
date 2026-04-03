package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/auth"
	"github.com/yourname/privatedrive/internal/config"
	"github.com/yourname/privatedrive/internal/db"
	redisclient "github.com/yourname/privatedrive/internal/redis"
	"github.com/yourname/privatedrive/internal/server"
	"github.com/yourname/privatedrive/internal/smtp"
)

// Version and BuildDate are injected at build time via -ldflags.
var (
	Version   = "dev"
	BuildDate = "unknown"
)

func main() {
	// ── Logging ───────────────────────────────────────────────────────────
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = log.With().Caller().Logger()

	log.Info().
		Str("version", Version).
		Str("built", BuildDate).
		Msg("PrivateDrive starting")

	// ── Config ────────────────────────────────────────────────────────────
	cfg, err := config.Load()
	if err != nil {
		log.Fatal().Err(err).Msg("failed to load configuration")
	}

	if cfg.IsDev() {
		log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr})
		log.Info().Msg("running in development mode")
	}

	// ── Context with graceful shutdown ────────────────────────────────────
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// ── Database ──────────────────────────────────────────────────────────
	pool, err := db.New(ctx, cfg)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to connect to PostgreSQL")
	}
	defer pool.Close()

	// ── Run migrations ────────────────────────────────────────────────────
	if err := db.RunMigrations(ctx, pool); err != nil {
		log.Fatal().Err(err).Msg("failed to run database migrations")
	}

	// ── Redis ─────────────────────────────────────────────────────────────
	rdb, err := redisclient.New(ctx, cfg)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to connect to Redis")
	}
	defer rdb.Close()

	// ── HTTP Server ───────────────────────────────────────────────────────
	// Audit service — async buffered writer, drain on shutdown.
	auditSvc := audit.NewService(pool)
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		auditSvc.Close(shutdownCtx)
	}()

	// SMTP mailer.
	mailer := smtp.New(cfg)

	// Auth handler.
	authHandler, err := auth.NewHandler(pool, rdb, cfg, mailer, auditSvc)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to initialise auth handler")
	}

	srv := server.New(cfg, pool, rdb, authHandler, auditSvc, Version, BuildDate)
	if err := srv.Start(ctx); err != nil {
		log.Fatal().Err(err).Msg("server error")
	}

	log.Info().Msg("PrivateDrive stopped")
}
