package audit

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

const (
	bufferSize  = 512
	flushPeriod = 5 * time.Second
	batchSize   = 64
)

// Service is an async, buffered audit log writer that implements Logger.
// Log calls never block; events are batched and flushed to PostgreSQL
// periodically or when the buffer is full. Call Close to drain on shutdown.
type Service struct {
	db  *pgxpool.Pool
	ch  chan Event
	wg  sync.WaitGroup
}

// NewService creates a Service and starts the background flush goroutine.
// Call Close(ctx) during graceful shutdown to drain the buffer.
func NewService(db *pgxpool.Pool) *Service {
	s := &Service{
		db: db,
		ch: make(chan Event, bufferSize),
	}
	s.wg.Add(1)
	go s.run()
	return s
}

// Log enqueues an audit event for async persistence. It is safe for concurrent
// use. If the internal buffer is full, the event is dropped and a warning is
// logged — this trades strict completeness for non-blocking caller behaviour.
func (s *Service) Log(ctx context.Context, event Event) {
	select {
	case s.ch <- event:
	default:
		log.Warn().Str("event_type", event.Type).Msg("audit: buffer full, event dropped")
	}
}

// Close drains all buffered events and stops the background goroutine.
func (s *Service) Close(ctx context.Context) {
	close(s.ch)
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
		log.Warn().Msg("audit: shutdown timeout, some events may be lost")
	}
}

func (s *Service) run() {
	defer s.wg.Done()
	ticker := time.NewTicker(flushPeriod)
	defer ticker.Stop()

	var batch []Event
	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := s.writeBatch(context.Background(), batch); err != nil {
			log.Error().Err(err).Int("count", len(batch)).Msg("audit: flush failed")
		}
		batch = batch[:0]
	}

	for {
		select {
		case ev, ok := <-s.ch:
			if !ok {
				// Channel closed — flush remainder and exit.
				flush()
				return
			}
			batch = append(batch, ev)
			if len(batch) >= batchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

func (s *Service) writeBatch(ctx context.Context, events []Event) error {
	const q = `
		INSERT INTO audit_logs
		  (event_type, actor_id, actor_email, target_user_id,
		   resource_type, resource_id, resource_name,
		   metadata, ip_address, user_agent, is_admin_action)
		VALUES
		  ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, ev := range events {
		var actorID, targetUserID, resourceID *uuid.UUID
		actorID = ev.ActorID
		targetUserID = ev.TargetUserID
		resourceID = ev.ResourceID

		var meta []byte
		if ev.Metadata != nil {
			meta, _ = json.Marshal(ev.Metadata)
		}

		if _, err := tx.Exec(ctx, q,
			ev.Type,
			actorID,
			ev.ActorEmail,
			targetUserID,
			ev.ResourceType,
			resourceID,
			ev.ResourceName,
			meta,
			ev.IPAddress,
			ev.UserAgent,
			ev.IsAdminAction,
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
