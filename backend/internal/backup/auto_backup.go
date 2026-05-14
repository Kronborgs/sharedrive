package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/audit"
)

// AutoConfig holds a user's automatic backup schedule configuration.
type AutoConfig struct {
	Enabled       bool       `json:"enabled"`
	IntervalHours int        `json:"interval_hours"`
	RetentionDays int        `json:"retention_days"`
	FolderIDs     []string   `json:"folder_ids"`
	LastRunAt     *time.Time `json:"last_run_at,omitempty"`
}

// AutoBackupService manages automatic scheduled backups for the tertiary tier
// and the buddy push tier.
// It uses the wrapped_key stored in backup_passwords to recover the raw token
// at schedule time — the user never needs to re-enter their token.
type AutoBackupService struct {
	db       *pgxpool.Pool
	wrapKey  string
	tertiary *TertiaryService
	buddy    *BuddyService
	buddyCfg *BuddyConfigService
	auditSvc audit.Logger
}

// NewAutoBackupService creates an AutoBackupService.
func NewAutoBackupService(db *pgxpool.Pool, wrapKey string, tertiary *TertiaryService, buddy *BuddyService, buddyCfg *BuddyConfigService, auditSvc audit.Logger) *AutoBackupService {
	return &AutoBackupService{db: db, wrapKey: wrapKey, tertiary: tertiary, buddy: buddy, buddyCfg: buddyCfg, auditSvc: auditSvc}
}

// Get returns the auto backup config for userID, or a sensible default.
func (s *AutoBackupService) Get(ctx context.Context, userID uuid.UUID) (*AutoConfig, error) {
	var cfg AutoConfig
	var folderIDs []string
	err := s.db.QueryRow(ctx,
		`SELECT enabled, interval_hours, retention_days, COALESCE(folder_ids, '{}'), last_run_at
		 FROM user_backup_auto_config WHERE user_id = $1`,
		userID,
	).Scan(&cfg.Enabled, &cfg.IntervalHours, &cfg.RetentionDays, &folderIDs, &cfg.LastRunAt)
	if err == pgx.ErrNoRows {
		return &AutoConfig{Enabled: false, IntervalHours: 24, RetentionDays: 30, FolderIDs: []string{}}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("auto backup: get: %w", err)
	}
	cfg.FolderIDs = folderIDs
	return &cfg, nil
}

// Set upserts the auto backup schedule for userID.
func (s *AutoBackupService) Set(ctx context.Context, userID uuid.UUID, enabled bool, intervalHours int, retentionDays int, folderIDs []string) error {
	if intervalHours < 1 {
		intervalHours = 24
	}
	if retentionDays < 1 {
		retentionDays = 30
	}
	if folderIDs == nil {
		folderIDs = []string{}
	}
	_, err := s.db.Exec(ctx,
		`INSERT INTO user_backup_auto_config (user_id, enabled, interval_hours, retention_days, folder_ids, updated_at)
		 VALUES ($1, $2, $3, $4, $5, NOW())
		 ON CONFLICT (user_id) DO UPDATE
		 SET enabled        = EXCLUDED.enabled,
		     interval_hours = EXCLUDED.interval_hours,
		     retention_days = EXCLUDED.retention_days,
		     folder_ids     = EXCLUDED.folder_ids,
		     updated_at     = NOW()`,
		userID, enabled, intervalHours, retentionDays, folderIDs,
	)
	if err != nil {
		return fmt.Errorf("auto backup: set: %w", err)
	}
	return nil
}

// computeFileHash returns a SHA-256 fingerprint of the non-deleted file tree
// for userID. If folderIDs is non-empty, only those subtrees are included.
// An empty file set hashes to the SHA-256 of "".
func (s *AutoBackupService) computeFileHash(ctx context.Context, userID uuid.UUID, folderIDs []uuid.UUID) (string, error) {
	var checksums []string

	if len(folderIDs) == 0 {
		rows, err := s.db.Query(ctx,
			`SELECT COALESCE(checksum_sha256, '') FROM files
			 WHERE owner_id = $1 AND deleted_at IS NULL AND is_folder = FALSE
			 ORDER BY id`,
			userID,
		)
		if err != nil {
			return "", fmt.Errorf("auto backup: hash query: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var cs string
			if err := rows.Scan(&cs); err != nil {
				return "", err
			}
			checksums = append(checksums, cs)
		}
		if err := rows.Err(); err != nil {
			return "", fmt.Errorf("auto backup: hash rows: %w", err)
		}
	} else {
		rows, err := s.db.Query(ctx,
			`WITH RECURSIVE subtree AS (
			   SELECT id FROM files
			   WHERE id = ANY($2) AND owner_id = $1 AND deleted_at IS NULL
			   UNION ALL
			   SELECT f.id FROM files f
			   JOIN subtree st ON f.parent_id = st.id
			   WHERE f.deleted_at IS NULL
			 )
			 SELECT COALESCE(f.checksum_sha256, '') FROM files f
			 JOIN subtree st ON f.id = st.id
			 WHERE f.is_folder = FALSE ORDER BY f.id`,
			userID, folderIDs,
		)
		if err != nil {
			return "", fmt.Errorf("auto backup: hash query selective: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var cs string
			if err := rows.Scan(&cs); err != nil {
				return "", err
			}
			checksums = append(checksums, cs)
		}
		if err := rows.Err(); err != nil {
			return "", fmt.Errorf("auto backup: hash rows selective: %w", err)
		}
	}

	sort.Strings(checksums)
	h := sha256.Sum256([]byte(strings.Join(checksums, ",")))
	return hex.EncodeToString(h[:]), nil
}

// resolveToken recovers the raw backup token from the user's stored wrapped_key.
func (s *AutoBackupService) resolveToken(ctx context.Context, userID uuid.UUID) (string, error) {
	if s.wrapKey == "" {
		return "", fmt.Errorf("auto backup: BACKUP_WRAP_KEY not configured")
	}
	var wrapped []byte
	err := s.db.QueryRow(ctx,
		`SELECT wrapped_key FROM backup_passwords
		 WHERE user_id = $1 AND revoked_at IS NULL AND wrapped_key IS NOT NULL
		 ORDER BY created_at DESC LIMIT 1`,
		userID,
	).Scan(&wrapped)
	if err != nil {
		return "", fmt.Errorf("auto backup: get wrapped key: %w", err)
	}
	rawBytes, err := UnwrapKey(wrapped, s.wrapKey)
	if err != nil {
		return "", fmt.Errorf("auto backup: unwrap key: %w", err)
	}
	return string(rawBytes), nil
}

// RunForUser runs a backup for userID if enough time has elapsed and the file
// tree has changed since the last backup. Returns (skipped, error).
func (s *AutoBackupService) RunForUser(ctx context.Context, userID uuid.UUID) (skipped bool, err error) {
	cfg, err := s.Get(ctx, userID)
	if err != nil || !cfg.Enabled {
		return true, err
	}

	// ── time check ──────────────────────────────────────────────────────────
	if cfg.LastRunAt != nil {
		nextRun := cfg.LastRunAt.Add(time.Duration(cfg.IntervalHours) * time.Hour)
		if time.Now().UTC().Before(nextRun) {
			return true, nil // not yet time
		}
	}

	// ── parse folder IDs ─────────────────────────────────────────────────────
	folderUUIDs, err := parseUUIDs(cfg.FolderIDs)
	if err != nil {
		return false, fmt.Errorf("auto backup: parse folder ids: %w", err)
	}

	// ── hash check ───────────────────────────────────────────────────────────
	currentHash, err := s.computeFileHash(ctx, userID, folderUUIDs)
	if err != nil {
		return false, fmt.Errorf("auto backup: compute hash: %w", err)
	}

	var storedHash string
	_ = s.db.QueryRow(ctx,
		`SELECT last_hash FROM user_backup_auto_config WHERE user_id = $1`, userID,
	).Scan(&storedHash)

	if currentHash == storedHash && storedHash != "" {
		// No changes — bump last_run_at so the interval resets correctly.
		_, _ = s.db.Exec(ctx,
			`UPDATE user_backup_auto_config SET last_run_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
			userID)
		log.Info().Str("user_id", userID.String()).Msg("auto backup: skipped (no changes)")
		return true, nil
	}

	// ── run backup ────────────────────────────────────────────────────────────
	rawToken, err := s.resolveToken(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return true, nil // user has no backup password — skip silently
		}
		return false, err
	}

	if _, err := s.tertiary.Store(ctx, userID, rawToken, folderUUIDs); err != nil {
		return false, fmt.Errorf("auto backup: store: %w", err)
	}

	// Prune archives older than retention_days.
	s.tertiary.PruneByAge(userID, cfg.RetentionDays)

	_, _ = s.db.Exec(ctx,
		`UPDATE user_backup_auto_config
		 SET last_hash = $2, last_run_at = NOW(), updated_at = NOW()
		 WHERE user_id = $1`,
		userID, currentHash,
	)

	if s.auditSvc != nil {
		s.auditSvc.Log(ctx, audit.Event{
			Type:    audit.EventBackupRunAuto,
			ActorID: &userID,
		})
	}

	log.Info().Str("user_id", userID.String()).Msg("auto backup: completed")
	return false, nil
}

// RunBuddyForUser runs an auto buddy push for userID if the schedule/change
// condition is met and the file hash has changed since the last push.
func (s *AutoBackupService) RunBuddyForUser(ctx context.Context, userID uuid.UUID) (skipped bool, err error) {
	if s.buddy == nil || s.buddyCfg == nil {
		return true, nil
	}

	cfg, err := s.buddyCfg.getAutoPushConfig(ctx, userID)
	if err != nil {
		return true, nil // no config row yet
	}

	// ── time check (skip if on_change mode — hash check is enough) ────────────
	if !cfg.OnChange && cfg.LastRunAt != nil {
		nextRun := cfg.LastRunAt.Add(time.Duration(cfg.IntervalHours) * time.Hour)
		if time.Now().UTC().Before(nextRun) {
			return true, nil // not yet time
		}
	}

	// ── parse folder IDs ──────────────────────────────────────────────────────
	folderUUIDs, err := parseUUIDs(cfg.FolderIDs)
	if err != nil {
		return false, fmt.Errorf("auto buddy push: parse folder ids: %w", err)
	}

	// ── hash check — only push when files have actually changed ───────────────
	currentHash, err := s.computeFileHash(ctx, userID, folderUUIDs)
	if err != nil {
		return false, fmt.Errorf("auto buddy push: compute hash: %w", err)
	}
	if currentHash == cfg.LastHash && cfg.LastHash != "" {
		// No changes; bump last_run_at so interval resets.
		_ = s.buddyCfg.updateAutoPushRun(ctx, userID, currentHash)
		return true, nil
	}

	// ── resolve token ─────────────────────────────────────────────────────────
	rawToken, err := s.resolveToken(ctx, userID)
	if err != nil {
		return false, err
	}

	// ── get peer config ───────────────────────────────────────────────────────
	peerURL, peerUserID, peerToken, err := s.buddyCfg.GetPeerConfig(ctx, userID)
	if err != nil {
		return false, fmt.Errorf("auto buddy push: peer config: %w", err)
	}

	// Mark in-progress so the UI reflects it.
	_ = s.buddyCfg.SetPushInProgress(ctx, userID, true, "")

	pushSize, pushErr := s.buddy.Push(ctx, userID, rawToken, folderUUIDs, peerURL, peerUserID, peerToken)
	if pushErr != nil {
		_ = s.buddyCfg.SetPushInProgress(ctx, userID, false, pushErr.Error())
		return false, fmt.Errorf("auto buddy push: %w", pushErr)
	}

	_ = s.buddyCfg.UpdateLastPush(ctx, userID, pushSize)
	_ = s.buddyCfg.updateAutoPushRun(ctx, userID, currentHash)

	if s.auditSvc != nil {
		s.auditSvc.Log(ctx, audit.Event{
			Type:    audit.EventBackupRunAuto,
			ActorID: &userID,
		})
	}

	log.Info().Str("user_id", userID.String()).Int64("bytes", pushSize).Msg("auto buddy push: completed")
	return false, nil
}

// RunScheduled iterates all users with auto backup enabled and runs their
// backups. Called by the server scheduler goroutine every 15 minutes.
func (s *AutoBackupService) RunScheduled(ctx context.Context) {
	// ── tertiary auto backup ──────────────────────────────────────────────────
	rows, err := s.db.Query(ctx,
		`SELECT user_id FROM user_backup_auto_config WHERE enabled = TRUE`)
	if err != nil {
		log.Warn().Err(err).Msg("auto backup scheduler: query users")
		return
	}
	defer rows.Close()

	var userIDs []uuid.UUID
	for rows.Next() {
		var uid uuid.UUID
		if err := rows.Scan(&uid); err != nil {
			continue
		}
		userIDs = append(userIDs, uid)
	}

	for _, uid := range userIDs {
		skipped, err := s.RunForUser(ctx, uid)
		if err != nil {
			log.Error().Err(err).Str("user_id", uid.String()).Msg("auto backup scheduler")
		} else if !skipped {
			log.Info().Str("user_id", uid.String()).Msg("auto backup scheduler: backup completed")
		}
	}

	// ── buddy auto push ───────────────────────────────────────────────────────
	if s.buddyCfg == nil {
		return
	}
	buddyUserIDs, err := s.buddyCfg.GetAutoPushUsers(ctx)
	if err != nil {
		log.Warn().Err(err).Msg("auto buddy push scheduler: query users")
		return
	}
	for _, uid := range buddyUserIDs {
		skipped, err := s.RunBuddyForUser(ctx, uid)
		if err != nil {
			log.Error().Err(err).Str("user_id", uid.String()).Msg("auto buddy push scheduler")
		} else if !skipped {
			log.Info().Str("user_id", uid.String()).Msg("auto buddy push scheduler: completed")
		}
	}
}
