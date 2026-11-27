package mailcow

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const hostSetting = "mailcow_host"

type HostStore interface {
	LoadHost(context.Context) (string, error)
	SaveHost(context.Context, string) error
}

type PostgresHostStore struct {
	DB *pgxpool.Pool
}

func (s PostgresHostStore) LoadHost(ctx context.Context) (string, error) {
	var host string
	err := s.DB.QueryRow(ctx, "SELECT value FROM system_settings WHERE key = $1", hostSetting).Scan(&host)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return host, err
}

func (s PostgresHostStore) SaveHost(ctx context.Context, host string) error {
	_, err := s.DB.Exec(ctx, `INSERT INTO system_settings (key, value) VALUES ($1, $2)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, hostSetting, host)
	return err
}
