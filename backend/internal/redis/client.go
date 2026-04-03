package redis

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog/log"
	"github.com/yourname/privatedrive/internal/config"
)

// New creates and validates a Redis client connection.
func New(ctx context.Context, cfg *config.Config) (*redis.Client, error) {
	rdb := redis.NewClient(&redis.Options{
		Addr:     cfg.RedisAddr,
		Password: cfg.RedisPassword,
		DB:       cfg.RedisDB,
	})

	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}

	log.Info().
		Str("addr", cfg.RedisAddr).
		Int("db", cfg.RedisDB).
		Msg("connected to Redis")

	return rdb, nil
}
