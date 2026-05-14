package backup

// Buddy reverse tunnel — allows a server instance (publicly reachable) to push
// backup archives to a peer that sits behind CGNAT/NAT with no incoming ports.
//
// Flow:
//   1. CGNAT peer (B) connects via WebSocket to the public instance (A):
//      GET /api/v1/backup/buddy/tunnel
//      Authorization: Bearer <A-user's receive token>
//      X-Receiver-User-ID: <A-user's UUID>
//
//   2. A upgrades the connection and starts a yamux CLIENT session over it
//      (A opens streams; B accepts streams).
//
//   3. B starts a yamux SERVER session over the same connection and proxies
//      each accepted stream to its own local HTTP server (127.0.0.1:8080).
//
//   4. When A wants to push an archive to B it opens a yamux stream and makes
//      a normal multipart POST to B's /api/v1/backup/buddy/receive — identical
//      to a direct push, just tunnelled.
//
// No kernel modules, no NET_ADMIN capability, no extra Docker flags required.

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/hashicorp/yamux"
	"github.com/rs/zerolog/log"
	"nhooyr.io/websocket"
)

// ── Server-side tunnel manager (runs on A, the public instance) ──────────────

// TunnelManager stores active yamux sessions from CGNAT peers.
// Keyed by the LOCAL user ID on this instance whose buddy the peer represents.
type TunnelManager struct {
	mu       sync.Mutex
	sessions map[uuid.UUID]*yamux.Session
}

// NewTunnelManager creates an empty TunnelManager.
func NewTunnelManager() *TunnelManager {
	return &TunnelManager{sessions: make(map[uuid.UUID]*yamux.Session)}
}

// Register stores a yamux CLIENT session over the given net.Conn.
// A is the yamux client — it opens streams TO B.
// Any previous session for localUserID is closed first.
// The returned channel is closed when the session terminates.
func (tm *TunnelManager) Register(localUserID uuid.UUID, conn net.Conn) (<-chan struct{}, error) {
	cfg := yamux.DefaultConfig()
	cfg.KeepAliveInterval = 25 * time.Second
	cfg.ConnectionWriteTimeout = 30 * time.Second
	cfg.LogOutput = io.Discard

	sess, err := yamux.Client(conn, cfg)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("yamux client: %w", err)
	}

	done := make(chan struct{})

	tm.mu.Lock()
	if old := tm.sessions[localUserID]; old != nil {
		old.Close()
	}
	tm.sessions[localUserID] = sess
	tm.mu.Unlock()

	log.Info().Str("user_id", localUserID.String()).Msg("buddy tunnel: peer connected")

	// Watch for session close.
	go func() {
		<-sess.CloseChan()
		tm.mu.Lock()
		if tm.sessions[localUserID] == sess {
			delete(tm.sessions, localUserID)
		}
		tm.mu.Unlock()
		close(done)
		log.Info().Str("user_id", localUserID.String()).Msg("buddy tunnel: peer disconnected")
	}()

	return done, nil
}

// IsConnected returns true when there is an active tunnel for localUserID.
func (tm *TunnelManager) IsConnected(localUserID uuid.UUID) bool {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	sess := tm.sessions[localUserID]
	return sess != nil && !sess.IsClosed()
}

// HTTPTransport returns an *http.Transport that opens every connection through
// the active yamux session for localUserID.  Returns nil if no tunnel exists.
func (tm *TunnelManager) HTTPTransport(localUserID uuid.UUID) *http.Transport {
	tm.mu.Lock()
	sess := tm.sessions[localUserID]
	tm.mu.Unlock()
	if sess == nil || sess.IsClosed() {
		return nil
	}
	return &http.Transport{
		DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
			return sess.Open()
		},
		DisableCompression: true, // archive is already compressed+encrypted
	}
}

// ── Client-side tunnel (runs on B, the CGNAT peer) ───────────────────────────

// TunnelClient dials a peer's WebSocket tunnel endpoint and proxies every
// incoming yamux stream to this instance's own local HTTP server.
type TunnelClient struct {
	localAddr string // e.g. "127.0.0.1:8080"

	mu        sync.Mutex
	connected bool
	cancel    context.CancelFunc
}

// NewTunnelClient creates a TunnelClient that will proxy streams to localAddr.
// localAddr defaults to "127.0.0.1:8080" when empty.
func NewTunnelClient(localAddr string) *TunnelClient {
	if localAddr == "" {
		localAddr = "127.0.0.1:8080"
	}
	return &TunnelClient{localAddr: localAddr}
}

// Connect dials peerURL's tunnel endpoint and starts serving reverse streams.
//
//	peerURL        — base URL of the public instance, e.g. "https://sharedrive.dk"
//	receiveToken   — the receive token peerURL's user shared with us (their part of
//	                 the buddy setup, used to authenticate the tunnel connection)
//	receiverUserID — UUID of the user on peerURL who we are the peer for
func (tc *TunnelClient) Connect(ctx context.Context, peerURL, receiveToken, receiverUserID string) error {
	wsURL := strings.TrimRight(peerURL, "/") + "/api/v1/backup/buddy/tunnel"
	wsURL = strings.ReplaceAll(wsURL, "https://", "wss://")
	wsURL = strings.ReplaceAll(wsURL, "http://", "ws://")

	wsConn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{"buddy-tunnel"},
		HTTPHeader: http.Header{
			"Authorization":      []string{"Bearer " + receiveToken},
			"X-Receiver-User-ID": []string{receiverUserID},
		},
	})
	if err != nil {
		return fmt.Errorf("tunnel dial: %w", err)
	}

	// Create a child context that we can cancel on Disconnect.
	child, cancel := context.WithCancel(ctx)

	nc := websocket.NetConn(child, wsConn, websocket.MessageBinary)

	cfg := yamux.DefaultConfig()
	cfg.KeepAliveInterval = 25 * time.Second
	cfg.ConnectionWriteTimeout = 30 * time.Second
	cfg.LogOutput = io.Discard

	sess, err := yamux.Server(nc, cfg) // B is yamux server — accepts streams FROM A
	if err != nil {
		nc.Close()
		cancel()
		return fmt.Errorf("yamux server: %w", err)
	}

	tc.mu.Lock()
	if tc.cancel != nil {
		tc.cancel() // close any previous connection
	}
	tc.connected = true
	tc.cancel = cancel
	tc.mu.Unlock()

	log.Info().Str("peer", peerURL).Msg("buddy tunnel: connected to peer")

	go tc.serve(sess, cancel)
	return nil
}

// Disconnect closes an active tunnel connection.
func (tc *TunnelClient) Disconnect() {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	if tc.cancel != nil {
		tc.cancel()
		tc.cancel = nil
	}
}

// IsConnected reports whether there is an active outbound tunnel.
func (tc *TunnelClient) IsConnected() bool {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	return tc.connected
}

// serve loops accepting yamux streams from A and proxying each to the local HTTP.
func (tc *TunnelClient) serve(sess *yamux.Session, cancel context.CancelFunc) {
	defer func() {
		sess.Close()
		cancel()
		tc.mu.Lock()
		tc.connected = false
		tc.mu.Unlock()
		log.Info().Msg("buddy tunnel: disconnected from peer")
	}()

	for {
		stream, err := sess.Accept()
		if err != nil {
			return // session closed
		}
		go tc.proxyStream(stream)
	}
}

// proxyStream bridges one yamux stream bidirectionally to this instance's HTTP.
func (tc *TunnelClient) proxyStream(stream net.Conn) {
	defer stream.Close()

	local, err := net.DialTimeout("tcp", tc.localAddr, 5*time.Second)
	if err != nil {
		log.Warn().Err(err).Str("addr", tc.localAddr).Msg("buddy tunnel: proxy dial local failed")
		return
	}
	defer local.Close()

	done := make(chan struct{}, 2)
	go func() { io.Copy(local, stream); done <- struct{}{} }()
	go func() { io.Copy(stream, local); done <- struct{}{} }()
	<-done // wait for either direction to finish, then close both
}
