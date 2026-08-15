package rooms

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
	"github.com/yourname/privatedrive/internal/ratelimit"
)

type roomEvent struct {
	Type           string    `json:"type"`
	UserID         uuid.UUID `json:"user_id,omitempty"`
	GuestSessionID string    `json:"guest_session_id,omitempty"`
	DisplayName    string    `json:"display_name,omitempty"`
}

type roomClientEvent struct {
	Type string `json:"type"`
}

type roomHub struct {
	mu          sync.RWMutex
	subscribers map[uuid.UUID]map[chan string]struct{}
}

func newRoomHub() *roomHub {
	return &roomHub{subscribers: make(map[uuid.UUID]map[chan string]struct{})}
}

func (hub *roomHub) subscribe(roomID uuid.UUID) (<-chan string, func()) {
	updates := make(chan string, 8)
	hub.mu.Lock()
	if hub.subscribers[roomID] == nil {
		hub.subscribers[roomID] = make(map[chan string]struct{})
	}
	hub.subscribers[roomID][updates] = struct{}{}
	hub.mu.Unlock()
	return updates, func() {
		hub.mu.Lock()
		delete(hub.subscribers[roomID], updates)
		if len(hub.subscribers[roomID]) == 0 {
			delete(hub.subscribers, roomID)
		}
		hub.mu.Unlock()
		close(updates)
	}
}

func (hub *roomHub) publish(roomID uuid.UUID, payload string) {
	hub.mu.RLock()
	defer hub.mu.RUnlock()
	for updates := range hub.subscribers[roomID] {
		select {
		case updates <- payload:
		default:
		}
	}
}

func roomEventsChannel(roomID uuid.UUID) string {
	return "rooms:events:" + roomID.String()
}

func (handler *Handler) publish(ctx context.Context, roomID uuid.UUID) {
	handler.publishRoomEvent(ctx, roomID, roomEvent{Type: "messages_changed"})
}

func (handler *Handler) publishRoomEvent(ctx context.Context, roomID uuid.UUID, event roomEvent) {
	payload, err := json.Marshal(event)
	if err != nil {
		return
	}
	if handler.redis != nil {
		_ = handler.redis.Publish(ctx, roomEventsChannel(roomID), payload).Err()
		return
	}
	handler.hub.publish(roomID, string(payload))
}

func (handler *Handler) WebSocket(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return
	}
	currentUser := middleware.UserFromContext(request.Context())
	if _, err := handler.service.Get(request.Context(), currentUser.ID, roomID); err != nil {
		handler.respondError(w, err)
		return
	}
	if !handler.allowSocket(request.Context(), currentUser.ID, roomID) {
		httputil.RespondError(w, http.StatusTooManyRequests, "room socket rate limit exceeded")
		return
	}
	conn, err := websocket.Accept(w, request, nil)
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "room chat closed")
	conn.SetReadLimit(4096)

	updates, closeUpdates, err := handler.roomUpdates(request.Context(), roomID)
	if err != nil {
		return
	}
	defer closeUpdates()
	presence := roomEvent{Type: "presence_joined", UserID: currentUser.ID, DisplayName: currentUser.DisplayName}
	handler.publishRoomEvent(request.Context(), roomID, presence)
	defer handler.publishRoomEvent(context.Background(), roomID, roomEvent{Type: "presence_left", UserID: currentUser.ID, DisplayName: currentUser.DisplayName})
	handler.serveWebSocket(request.Context(), conn, roomID, currentUser.ID, currentUser.DisplayName, updates)
}

func (handler *Handler) allowSocket(ctx context.Context, userID, roomID uuid.UUID) bool {
	if handler.limiter == nil {
		return true
	}
	identity := userID.String() + ":" + roomID.String()
	allowed, _, _, err := handler.limiter.Allow(ctx, ratelimit.KeyUserRoomSocket, identity, 20, time.Minute)
	return err == nil && allowed
}

func (handler *Handler) roomUpdates(ctx context.Context, roomID uuid.UUID) (<-chan string, func(), error) {
	if handler.redis == nil {
		updates, unsubscribe := handler.hub.subscribe(roomID)
		return updates, unsubscribe, nil
	}
	pubsub := handler.redis.Subscribe(ctx, roomEventsChannel(roomID))
	if _, err := pubsub.Receive(ctx); err != nil {
		_ = pubsub.Close()
		return nil, func() {
			// Subscription setup failed, so there is no active Redis resource to close.
		}, err
	}
	updates := make(chan string, 8)
	go func() {
		defer close(updates)
		for message := range pubsub.Channel() {
			select {
			case updates <- message.Payload:
			case <-ctx.Done():
				return
			}
		}
	}()
	return updates, func() { _ = pubsub.Close() }, nil
}

func (handler *Handler) serveWebSocket(ctx context.Context, conn *websocket.Conn, roomID, userID uuid.UUID, displayName string, updates <-chan string) {
	incoming := readRoomClientEvents(ctx, conn)
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case payload, open := <-updates:
			if !open || conn.Write(ctx, websocket.MessageText, []byte(payload)) != nil {
				return
			}
		case event, open := <-incoming:
			if !open {
				return
			}
			if event.Type == "typing" && handler.allowTyping(ctx, userID, roomID) {
				handler.publishRoomEvent(ctx, roomID, roomEvent{Type: "typing", UserID: userID, DisplayName: displayName})
			}
		case <-ping.C:
			pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

func readRoomClientEvents(ctx context.Context, conn *websocket.Conn) <-chan roomClientEvent {
	incoming := make(chan roomClientEvent)
	go func() {
		defer close(incoming)
		for {
			var event roomClientEvent
			if err := wsjson.Read(ctx, conn, &event); err != nil {
				return
			}
			select {
			case incoming <- event:
			case <-ctx.Done():
				return
			}
		}
	}()
	return incoming
}

func (handler *Handler) allowTyping(ctx context.Context, userID, roomID uuid.UUID) bool {
	if handler.limiter == nil {
		return true
	}
	identity := userID.String() + ":" + roomID.String()
	allowed, _, _, err := handler.limiter.Allow(ctx, ratelimit.KeyUserRoomTyping, identity, 8, 5*time.Second)
	return err == nil && allowed
}
