package rooms

import (
	"context"
	"strconv"

	"github.com/jackc/pgx/v5"
)

const cleanupBatchSize = 100

// maintainChatStorage removes only Rooms-owned chat rows. Existing files,
// notes, and room resource references are deliberately outside this policy.
func (service *Service) maintainChatStorage(ctx context.Context) error {
	retentionDays, maxBytes, err := service.chatStorageSettings(ctx)
	if err != nil {
		return err
	}
	if retentionDays > 0 {
		if err := service.deleteExpiredMessages(ctx, retentionDays); err != nil {
			return err
		}
	}
	return service.trimChatToTarget(ctx, maxBytes*9/10)
}

func (service *Service) chatStorageSettings(ctx context.Context) (int, int64, error) {
	values := map[string]string{}
	rows, err := service.db.Query(ctx, `SELECT key, value FROM system_settings
		WHERE key IN ('rooms_message_retention_days', 'rooms_max_data_bytes')`)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return 0, 0, err
		}
		values[key] = value
	}
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	retentionDays, _ := strconv.Atoi(values["rooms_message_retention_days"])
	if retentionDays < 0 || retentionDays > 3650 {
		retentionDays = 0
	}
	maxBytes, _ := strconv.ParseInt(values["rooms_max_data_bytes"], 10, 64)
	if maxBytes < 1024*1024 {
		maxBytes = 500 * 1024 * 1024
	}
	return retentionDays, maxBytes, nil
}

func (service *Service) deleteExpiredMessages(ctx context.Context, retentionDays int) error {
	result, err := service.db.Exec(ctx, `DELETE FROM room_messages WHERE id IN (
		SELECT id FROM room_messages
		WHERE created_at < now() - make_interval(days => $1)
		ORDER BY created_at, id LIMIT $2
	)`, retentionDays, cleanupBatchSize)
	return service.recordChatCleanup(ctx, result.RowsAffected(), err)
}

func (service *Service) trimChatToTarget(ctx context.Context, targetBytes int64) error {
	usedBytes, err := service.chatDataBytes(ctx)
	if err != nil || usedBytes <= targetBytes {
		return err
	}
	result, err := service.db.Exec(ctx, `DELETE FROM room_messages WHERE id IN (
		SELECT id FROM room_messages ORDER BY created_at, id LIMIT $1
	)`, cleanupBatchSize)
	return service.recordChatCleanup(ctx, result.RowsAffected(), err)
}

func (service *Service) recordChatCleanup(ctx context.Context, deleted int64, cleanupErr error) error {
	if cleanupErr != nil || deleted == 0 {
		return cleanupErr
	}
	_, err := service.db.Exec(ctx, `INSERT INTO system_settings (key, value) VALUES ('rooms_last_cleanup_at', now()::text)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
	return err
}

func (service *Service) chatDataBytes(ctx context.Context) (int64, error) {
	var used int64
	err := service.db.QueryRow(ctx, `SELECT
		COALESCE((SELECT SUM(octet_length(body) + 128) FROM room_messages), 0) +
		COALESCE((SELECT SUM(octet_length(emoji) + 48) FROM room_reactions), 0) +
		COALESCE((SELECT COUNT(*) * 64 FROM room_read_state), 0)`).Scan(&used)
	if err == pgx.ErrNoRows {
		return 0, nil
	}
	return used, err
}
