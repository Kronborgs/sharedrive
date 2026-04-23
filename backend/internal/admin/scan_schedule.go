package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/httputil"
)

// ScanScheduleConfig is the schedule configuration for a single scan type.
type scanScheduleConfig struct {
	Enabled    bool   `json:"enabled"`
	Interval   string `json:"interval"`     // "hourly" | "daily" | "weekly" | "monthly"
	Hour       int    `json:"hour"`         // 0-23 (UTC)
	DayOfWeek  int    `json:"day_of_week"`  // 0=Sunday … 6=Saturday (for weekly)
	DayOfMonth int    `json:"day_of_month"` // 1-28 (for monthly, capped at 28 for safety)
}

type scanScheduleResponse struct {
	Corrupt        scanScheduleConfig `json:"corrupt"`
	Orphan         scanScheduleConfig `json:"orphan"`
	CorruptLastRun string             `json:"corrupt_last_run"` // RFC3339 or ""
	OrphanLastRun  string             `json:"orphan_last_run"`
}

// GetScanSchedule handles GET /api/v1/admin/storage/schedule
func (h *Handler) GetScanSchedule(w http.ResponseWriter, r *http.Request) {
	resp, err := loadScanSchedule(r.Context(), h.db)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, "database error")
		return
	}
	httputil.Respond(w, http.StatusOK, resp)
}

// PutScanSchedule handles PUT /api/v1/admin/storage/schedule
func (h *Handler) PutScanSchedule(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Corrupt scanScheduleConfig `json:"corrupt"`
		Orphan  scanScheduleConfig `json:"orphan"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	for _, cfg := range []scanScheduleConfig{req.Corrupt, req.Orphan} {
		switch cfg.Interval {
		case "hourly", "daily", "weekly", "monthly":
		default:
			httputil.RespondError(w, http.StatusBadRequest, "interval must be hourly, daily, weekly or monthly")
			return
		}
		if cfg.Hour < 0 || cfg.Hour > 23 {
			httputil.RespondError(w, http.StatusBadRequest, "hour must be 0-23")
			return
		}
		if cfg.DayOfWeek < 0 || cfg.DayOfWeek > 6 {
			httputil.RespondError(w, http.StatusBadRequest, "day_of_week must be 0-6")
			return
		}
		if cfg.DayOfMonth < 1 || cfg.DayOfMonth > 28 {
			httputil.RespondError(w, http.StatusBadRequest, "day_of_month must be 1-28")
			return
		}
	}

	corruptJSON, _ := json.Marshal(req.Corrupt)
	orphanJSON, _ := json.Marshal(req.Orphan)

	_, err := h.db.Exec(r.Context(), `
		INSERT INTO system_settings (key, value, updated_at) VALUES
		  ('scan_corrupt_schedule', $1, NOW()),
		  ('scan_orphan_schedule',  $2, NOW())
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
	`, string(corruptJSON), string(orphanJSON))
	if err != nil {
		log.Error().Err(err).Msg("admin.PutScanSchedule: upsert")
		httputil.RespondError(w, http.StatusInternalServerError, "database error")
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]any{"ok": true})
}

// ── internal helpers ──────────────────────────────────────────────────────────

func loadScanSchedule(ctx context.Context, db *pgxpool.Pool) (scanScheduleResponse, error) {
	rows, err := db.Query(ctx, `
		SELECT key, value FROM system_settings
		WHERE key IN (
		  'scan_corrupt_schedule', 'scan_corrupt_last_run',
		  'scan_orphan_schedule',  'scan_orphan_last_run'
		)`)
	if err != nil {
		return scanScheduleResponse{}, err
	}
	defer rows.Close()

	kv := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err == nil {
			kv[k] = v
		}
	}

	def := func(hour int) scanScheduleConfig {
		return scanScheduleConfig{Enabled: false, Interval: "daily", Hour: hour, DayOfWeek: 1, DayOfMonth: 1}
	}

	var resp scanScheduleResponse
	resp.CorruptLastRun = kv["scan_corrupt_last_run"]
	resp.OrphanLastRun = kv["scan_orphan_last_run"]
	resp.Corrupt = def(2)
	if v := kv["scan_corrupt_schedule"]; v != "" {
		_ = json.Unmarshal([]byte(v), &resp.Corrupt)
	}
	resp.Orphan = def(3)
	if v := kv["scan_orphan_schedule"]; v != "" {
		_ = json.Unmarshal([]byte(v), &resp.Orphan)
	}
	return resp, nil
}

// isDue returns true when a scheduled scan is due to run now.
func isDue(cfg scanScheduleConfig, lastRunStr string, now time.Time) bool {
	if !cfg.Enabled {
		return false
	}
	var lastRun time.Time
	if lastRunStr != "" {
		lastRun, _ = time.Parse(time.RFC3339, lastRunStr)
	}
	switch cfg.Interval {
	case "hourly":
		return now.Sub(lastRun) >= time.Hour
	case "daily":
		scheduled := time.Date(now.Year(), now.Month(), now.Day(), cfg.Hour, 0, 0, 0, time.UTC)
		return now.After(scheduled) && lastRun.Before(scheduled)
	case "weekly":
		daysBack := int(now.UTC().Weekday()) - cfg.DayOfWeek
		if daysBack < 0 {
			daysBack += 7
		}
		d := now.UTC().AddDate(0, 0, -daysBack)
		scheduled := time.Date(d.Year(), d.Month(), d.Day(), cfg.Hour, 0, 0, 0, time.UTC)
		return now.After(scheduled) && lastRun.Before(scheduled)
	case "monthly":
		day := cfg.DayOfMonth
		if day > 28 {
			day = 28
		}
		n := now.UTC()
		scheduled := time.Date(n.Year(), n.Month(), day, cfg.Hour, 0, 0, 0, time.UTC)
		if n.Before(scheduled) {
			// this month's slot hasn't arrived yet — check last month
			prev := n.AddDate(0, -1, 0)
			scheduled = time.Date(prev.Year(), prev.Month(), day, cfg.Hour, 0, 0, 0, time.UTC)
		}
		return now.After(scheduled) && lastRun.Before(scheduled)
	}
	return false
}

func updateLastRun(ctx context.Context, db *pgxpool.Pool, key string, t time.Time) {
	_, err := db.Exec(ctx, `
		INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
	`, key, t.UTC().Format(time.RFC3339))
	if err != nil {
		log.Warn().Err(err).Str("key", key).Msg("scan_schedule: update last run")
	}
}

// StartScheduler launches a background goroutine that runs scheduled scans.
// It ticks every minute and checks whether either scan is due.
func StartScheduler(ctx context.Context, db *pgxpool.Pool, filesRoot string) {
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				runScheduledScans(ctx, db, filesRoot, now)
			}
		}
	}()
}

func runScheduledScans(ctx context.Context, db *pgxpool.Pool, filesRoot string, now time.Time) {
	sched, err := loadScanSchedule(ctx, db)
	if err != nil {
		log.Warn().Err(err).Msg("scan_schedule: load schedule")
		return
	}

	if isDue(sched.Corrupt, sched.CorruptLastRun, now) {
		log.Info().Msg("scan_schedule: starting scheduled corrupt scan")
		result, err := runCorruptScan(ctx, db, filesRoot)
		if err != nil {
			log.Warn().Err(err).Msg("scan_schedule: corrupt scan failed")
		} else {
			log.Info().
				Int("scanned", result.ScannedFiles).
				Int("corrupt", len(result.CorruptFiles)).
				Int64("duration_ms", result.DurationMs).
				Msg("scan_schedule: corrupt scan completed")
			updateLastRun(ctx, db, "scan_corrupt_last_run", now)
		}
	}

	if isDue(sched.Orphan, sched.OrphanLastRun, now) {
		log.Info().Msg("scan_schedule: starting scheduled orphan scan")
		result, err := runOrphanScan(ctx, db, filesRoot)
		if err != nil {
			log.Warn().Err(err).Msg("scan_schedule: orphan scan failed")
		} else {
			log.Info().
				Int("scanned", result.ScannedBlobs).
				Int("orphans", len(result.OrphanFiles)).
				Int64("duration_ms", result.DurationMs).
				Msg("scan_schedule: orphan scan completed")
			updateLastRun(ctx, db, "scan_orphan_last_run", now)
		}
	}
}
