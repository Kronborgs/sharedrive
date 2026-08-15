package rooms

import (
	"context"
	"net/http"
	"time"

	"nhooyr.io/websocket"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/ratelimit"
)

func (handler *Handler) GuestWebSocket(w http.ResponseWriter, request *http.Request) {
	access, ok := handler.guestAccess(w, request)
	if !ok {
		return
	}
	identity := access.SessionID.String() + ":" + access.RoomID.String()
	if !handler.allowRoomAction(request.Context(), ratelimit.KeyGuestRoomMutation, identity, 20, time.Minute) {
		httputil.RespondError(w, http.StatusTooManyRequests, "guest room socket rate limit exceeded")
		return
	}
	conn, err := websocket.Accept(w, request, nil)
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "room guest chat closed")
	conn.SetReadLimit(4096)
	updates, closeUpdates, err := handler.roomUpdates(request.Context(), access.RoomID)
	if err != nil {
		return
	}
	defer closeUpdates()
	joined := roomEvent{Type: "presence_joined", GuestSessionID: access.SessionID.String(), DisplayName: access.DisplayName}
	handler.publishRoomEvent(request.Context(), access.RoomID, joined)
	defer handler.publishRoomEvent(context.Background(), access.RoomID, roomEvent{Type: "presence_left", GuestSessionID: access.SessionID.String(), DisplayName: access.DisplayName})
	handler.serveGuestSocket(request.Context(), conn, access, updates)
}

func (handler *Handler) serveGuestSocket(ctx context.Context, conn *websocket.Conn, access roomGuestAccess, updates <-chan string) {
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
			if event.Type == "typing" && access.CanChat && handler.allowRoomAction(ctx, ratelimit.KeyGuestRoomMutation, access.SessionID.String()+":typing", 8, 5*time.Second) {
				handler.publishRoomEvent(ctx, access.RoomID, roomEvent{Type: "typing", GuestSessionID: access.SessionID.String(), DisplayName: access.DisplayName})
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
