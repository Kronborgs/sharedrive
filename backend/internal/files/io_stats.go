package files

import (
	"context"
	"fmt"
	"strconv"
	"time"

	goredis "github.com/redis/go-redis/v9"
)

// IOTracker records per-user upload/download byte counts in Redis using
// per-minute hash keys, so the admin dashboard can show near-real-time
// transfer rates.
//
// Key format :  io:{direction}:{epoch_minute}
// Hash field :  {userID}
// TTL         : 10 minutes
type IOTracker struct {
	redis *goredis.Client
}

// NewIOTracker creates an IOTracker. rdb may be nil (no-op mode).
func NewIOTracker(rdb *goredis.Client) *IOTracker {
	return &IOTracker{redis: rdb}
}

func epochMinute() int64 { return time.Now().Unix() / 60 }

func ioKey(direction string, minute int64) string {
	return fmt.Sprintf("io:%s:%d", direction, minute)
}

// TrackUpload records n bytes uploaded by userID.
func (t *IOTracker) TrackUpload(ctx context.Context, userID string, n int64) {
	if t.redis == nil || n <= 0 {
		return
	}
	k := ioKey("upload", epochMinute())
	pipe := t.redis.Pipeline()
	pipe.HIncrBy(ctx, k, userID, n)
	pipe.Expire(ctx, k, 10*time.Minute)
	pipe.Exec(ctx) //nolint:errcheck
}

// TrackDownload records n bytes downloaded by userID.
func (t *IOTracker) TrackDownload(ctx context.Context, userID string, n int64) {
	if t.redis == nil || n <= 0 {
		return
	}
	k := ioKey("download", epochMinute())
	pipe := t.redis.Pipeline()
	pipe.HIncrBy(ctx, k, userID, n)
	pipe.Expire(ctx, k, 10*time.Minute)
	pipe.Exec(ctx) //nolint:errcheck
}

// UserIOStats holds the aggregated I/O counters for one user.
type UserIOStats struct {
	UserID          string `json:"user_id"`
	UploadBytes     int64  `json:"upload_bytes"`
	DownloadBytes   int64  `json:"download_bytes"`
	UploadBytesPS   int64  `json:"upload_bytes_per_sec"`
	DownloadBytesPS int64  `json:"download_bytes_per_sec"`
}

// CurrentStats returns per-user I/O aggregated over the last two minutes.
// Returns an empty slice when Redis is not configured.
func (t *IOTracker) CurrentStats(ctx context.Context) ([]UserIOStats, error) {
	if t.redis == nil {
		return nil, nil
	}

	now := epochMinute()
	uploadMap := map[string]int64{}
	downloadMap := map[string]int64{}
	// Current minute only — gives the most up-to-date picture for the live dashboard.
	// We fall back to including the previous minute so activity isn't lost at the
	// exact second a new minute rolls over.
	curUp, _ := t.redis.HGetAll(ctx, ioKey("upload", now)).Result()
	curDown, _ := t.redis.HGetAll(ctx, ioKey("download", now)).Result()
	prevUp, _ := t.redis.HGetAll(ctx, ioKey("upload", now-1)).Result()
	prevDown, _ := t.redis.HGetAll(ctx, ioKey("download", now-1)).Result()

	// Use whichever minute has more activity (prefer current).
	activeUp := curUp
	if len(curUp) == 0 {
		activeUp = prevUp
	}
	activeDown := curDown
	if len(curDown) == 0 {
		activeDown = prevDown
	}

	for uid, v := range activeUp {
		n, _ := strconv.ParseInt(v, 10, 64)
		uploadMap[uid] += n
	}
	for uid, v := range activeDown {
		n, _ := strconv.ParseInt(v, 10, 64)
		downloadMap[uid] += n
	}

	// Merge into result slice (only users with non-zero activity).
	seen := map[string]struct{}{}
	for uid := range uploadMap {
		seen[uid] = struct{}{}
	}
	for uid := range downloadMap {
		seen[uid] = struct{}{}
	}

	// Compute bytes/sec: divide 2-minute total by 120 seconds.
	// The dashboard polls every 3s so this gives a smoothed rate.
	result := make([]UserIOStats, 0, len(seen))
	for uid := range seen {
		up := uploadMap[uid]
		down := downloadMap[uid]
		result = append(result, UserIOStats{
			UserID:          uid,
			UploadBytes:     up,
			DownloadBytes:   down,
			UploadBytesPS:   up / 60,
			DownloadBytesPS: down / 60,
		})
	}
	return result, nil
}
