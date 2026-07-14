package backup

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// buddyHTTPClient is a dedicated HTTP client for buddy push operations.
// It enforces TLS 1.2+ and sets a reasonable timeout.
var buddyHTTPClient = &http.Client{
	Timeout: 10 * time.Minute, // large archives may take a while
	Transport: &http.Transport{
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
	},
}

// ErrPeerStorageUnavailable is returned when the peer responds with 503,
// meaning it does not have BACKUPS_ROOT configured. This is a configuration
// issue on the peer, not a transient error — callers should not record it as
// a persistent failure.
var ErrPeerStorageUnavailable = fmt.Errorf("buddy push: peer har ikke backup-lager konfigureret")

// BuddyServerInfo is returned by GET /api/v1/backup/buddy/server-info on a peer.
type BuddyServerInfo struct {
	DirectUploadURL string `json:"direct_upload_url"` // empty if not configured
}

// fetchPeerDirectUploadURL probes a peer for its preferred upload URL.
// Returns the direct URL if the peer has one configured, otherwise returns baseURL.
func fetchPeerDirectUploadURL(ctx context.Context, baseURL string) string {
	infoURL := strings.TrimRight(baseURL, "/") + "/api/v1/backup/buddy/server-info"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, infoURL, nil)
	if err != nil {
		log.Warn().Err(err).Str("info_url", infoURL).Msg("buddy: could not build server-info request, using base URL")
		return baseURL
	}
	resp, err := buddyHTTPClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		log.Warn().Err(err).Str("info_url", infoURL).Msg("buddy: server-info request failed, using base URL for upload")
		return baseURL
	}
	defer resp.Body.Close()
	var info BuddyServerInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil || info.DirectUploadURL == "" {
		log.Info().Str("info_url", infoURL).Msg("buddy: peer has no direct_upload_url set, using base URL for upload")
		return baseURL
	}
	log.Info().Str("base_url", baseURL).Str("upload_url", info.DirectUploadURL).Msg("buddy: using peer direct upload URL")
	return info.DirectUploadURL
}

// Push: stream an encrypted archive to a peer server over HTTPS.
// Receive: accept an archive pushed from a peer and store it on disk.
// Archives pushed to this server are stored under BACKUPS_ROOT/buddy/<senderUserID>/.
// PushProgress holds live progress for an in-flight push operation.
type PushProgress struct {
	TotalBytes int64     `json:"total_bytes"` // archive size (set after export)
	SentBytes  int64     `json:"sent_bytes"`  // bytes read by HTTP transport so far
	StartedAt  time.Time `json:"started_at"`
	Active     bool      `json:"active"`
}

type BuddyService struct {
	root         string
	backups      *Service
	tunnelMgr    *TunnelManager // optional — enables tunnel-based push to CGNAT peers
	tunnelClient *TunnelClient  // optional — enables push via outgoing tunnel (bypasses peer Cloudflare)
	pushProgress sync.Map       // userID (string) → *pushProgressEntry
}

type pushProgressEntry struct {
	totalBytes int64 // set atomically after export
	sentBytes  int64 // incremented atomically by countingReader
	startedAt  time.Time
	active     int32 // 1 = active, 0 = done
}

// NewBuddyService creates a BuddyService.
func NewBuddyService(root string, backups *Service) *BuddyService {
	return &BuddyService{root: root, backups: backups}
}

// PushProgress returns a snapshot of the current push progress for userID.
// active=false and zero values are returned if no push is in flight.
func (s *BuddyService) GetPushProgress(userID uuid.UUID) PushProgress {
	v, ok := s.pushProgress.Load(userID.String())
	if !ok {
		return PushProgress{}
	}
	e := v.(*pushProgressEntry)
	return PushProgress{
		TotalBytes: atomic.LoadInt64(&e.totalBytes),
		SentBytes:  atomic.LoadInt64(&e.sentBytes),
		StartedAt:  e.startedAt,
		Active:     atomic.LoadInt32(&e.active) == 1,
	}
}

// SetTunnelManager wires the reverse-tunnel manager so Push can route through
// an active tunnel when the peer is behind CGNAT.
func (s *BuddyService) SetTunnelManager(tm *TunnelManager) { s.tunnelMgr = tm }

// SetTunnelClient wires the outgoing tunnel client so Push can route through
// the existing outgoing WebSocket connection when the peer sits behind Cloudflare.
// yamux supports bidirectional stream opening: the peer's TunnelManager will
// accept the stream and proxy it to the peer's local HTTP server.
func (s *BuddyService) SetTunnelClient(tc *TunnelClient) { s.tunnelClient = tc }

// BuddyArchive describes an archive received from a peer.
type BuddyArchive struct {
	Filename         string    `json:"filename"`
	SizeBytes        int64     `json:"size_bytes"`
	ReceivedAt       time.Time `json:"received_at"`
	TotalStoredBytes int64     `json:"total_stored_bytes,omitempty"` // populated by BuddyReceive handler
}

// PushResult is returned from BuddyService.Push on success.
type PushResult struct {
	ArchiveBytes   int64 // size of the archive we uploaded
	PeerTotalBytes int64 // total bytes now stored at the peer for us (from peer's response; 0 if unknown)
}

// buddyDir returns (and creates) the per-user directory for received archives.
func (s *BuddyService) buddyDir(userID uuid.UUID) (string, error) {
	dir := filepath.Join(s.root, "buddy", userID.String())
	if err := os.MkdirAll(dir, 0750); err != nil {
		return "", fmt.Errorf("buddy: mkdir: %w", err)
	}
	return dir, nil
}

// Push exports the user's archive to a peer Sharedrive server.
// peerBaseURL is the peer's base URL; peerUserID is the peer's user UUID;
// peerToken is the receive token the peer generated for us to authenticate.
// folderIDs restricts scope; pass nil to include all files.
// Returns a PushResult with archive size and the peer's reported total stored bytes.
type buddyPushSession struct {
	ctx         context.Context
	userID      uuid.UUID
	peerBaseURL string
	peerUserID  string
	peerToken   string
	archiveName string
	archiveSize int64
	tmp         *os.File
	progress    *pushProgressEntry
}

func (s *BuddyService) Push(ctx context.Context, userID uuid.UUID, rawToken string, folderIDs []uuid.UUID, peerBaseURL, peerUserID, peerToken string) (PushResult, error) {
	session, err := s.newBuddyPushSession(ctx, userID, rawToken, folderIDs, peerBaseURL, peerUserID, peerToken)
	if err != nil {
		return PushResult{}, err
	}
	defer session.Close()

	if result, handled, err := s.pushViaIncomingTunnel(session); handled {
		return result, err
	}
	if result, handled, err := s.pushViaOutgoingTunnel(session); handled {
		return result, err
	}

	return s.pushDirect(session)
}

func (s *BuddyService) newBuddyPushSession(ctx context.Context, userID uuid.UUID, rawToken string, folderIDs []uuid.UUID, peerBaseURL, peerUserID, peerToken string) (*buddyPushSession, error) {
	tmp, err := os.CreateTemp("", "shdbak-buddy-push-*")
	if err != nil {
		return nil, fmt.Errorf("buddy push: create temp: %w", err)
	}

	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}

	if err := s.backups.Export(ctx, tmp, userID, rawToken, folderIDs); err != nil {
		cleanup()
		return nil, fmt.Errorf("buddy push: export: %w", err)
	}

	fi, err := tmp.Stat()
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("buddy push: stat: %w", err)
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		cleanup()
		return nil, fmt.Errorf("buddy push: seek: %w", err)
	}

	progEntry := &pushProgressEntry{startedAt: time.Now()}
	atomic.StoreInt32(&progEntry.active, 1)
	atomic.StoreInt64(&progEntry.totalBytes, fi.Size())
	s.pushProgress.Store(userID.String(), progEntry)

	return &buddyPushSession{
		ctx:         ctx,
		userID:      userID,
		peerBaseURL: peerBaseURL,
		peerUserID:  peerUserID,
		peerToken:   peerToken,
		archiveName: time.Now().UTC().Format("20060102T150405Z") + ".zip",
		archiveSize: fi.Size(),
		tmp:         tmp,
		progress:    progEntry,
	}, nil
}

func (s *buddyPushSession) Close() {
	if s.progress != nil {
		atomic.StoreInt32(&s.progress.active, 0)
	}
	if s.tmp != nil {
		_ = s.tmp.Close()
		_ = os.Remove(s.tmp.Name())
	}
}

func (s *buddyPushSession) Result(peerTotal int64) PushResult {
	return PushResult{ArchiveBytes: s.archiveSize, PeerTotalBytes: peerTotal}
}

func (s *buddyPushSession) streamBody() (io.ReadCloser, string) {
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go writeBuddyPushMultipartBody(s, pw, mw)
	return pr, mw.FormDataContentType()
}

func writeBuddyPushMultipartBody(session *buddyPushSession, pw *io.PipeWriter, mw *multipart.Writer) {
	if err := mw.WriteField("receiver_user_id", session.peerUserID); err != nil {
		_ = pw.CloseWithError(err)
		return
	}

	fw, err := mw.CreateFormFile("file", session.archiveName)
	if err != nil {
		_ = pw.CloseWithError(err)
		return
	}

	cr := &countingReader{r: session.tmp, counter: &session.progress.sentBytes}
	if _, err := io.Copy(fw, cr); err != nil {
		_ = pw.CloseWithError(err)
		return
	}

	if err := mw.Close(); err != nil {
		_ = pw.CloseWithError(err)
		return
	}
	_ = pw.Close()
}

func parseBuddyReceiveResponse(r io.Reader) int64 {
	var resp BuddyArchive
	if err := json.NewDecoder(io.LimitReader(r, 4096)).Decode(&resp); err == nil {
		return resp.TotalStoredBytes
	}
	return 0
}

func (s *buddyPushSession) doPush(client *http.Client, endpoint string) (int64, error) {
	if _, err := s.tmp.Seek(0, io.SeekStart); err != nil {
		return 0, fmt.Errorf("seek: %w", err)
	}

	body, contentType := s.streamBody()
	defer body.Close()

	req, err := http.NewRequestWithContext(s.ctx, http.MethodPost, endpoint, body)
	if err != nil {
		return 0, fmt.Errorf("request: %w", err)
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Authorization", "Bearer "+s.peerToken)
	req.Header.Set("X-Buddy-Sender-User-ID", s.userID.String())

	resp, err := client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return 0, readBuddyPushResponseError(resp)
	}

	return parseBuddyReceiveResponse(resp.Body), nil
}

func readBuddyPushResponseError(resp *http.Response) error {
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	detail := strings.TrimSpace(string(msg))
	if resp.StatusCode == http.StatusServiceUnavailable {
		return ErrPeerStorageUnavailable
	}
	if detail == "" {
		detail = "no details from peer"
	}
	return fmt.Errorf("peer returnerede HTTP %d: %s", resp.StatusCode, detail)
}

func newBuddyTunnelHTTPClient(tr http.RoundTripper) *http.Client {
	return &http.Client{Transport: tr, Timeout: 30 * time.Minute}
}

func (s *BuddyService) pushViaIncomingTunnel(session *buddyPushSession) (PushResult, bool, error) {
	if s.tunnelMgr == nil {
		return PushResult{}, false, nil
	}
	tr := s.tunnelMgr.HTTPTransport(session.userID)
	if tr == nil {
		return PushResult{}, false, nil
	}

	log.Info().Str("user_id", session.userID.String()).Str("peer", session.peerBaseURL).Int64("archive_bytes", session.archiveSize).Msg("buddy: pushing via incoming tunnel")
	peerTotal, err := session.doPush(newBuddyTunnelHTTPClient(tr), "http://tunnel-peer/api/v1/backup/buddy/receive")
	if err != nil {
		return PushResult{}, true, fmt.Errorf("buddy push (incoming tunnel): %w", err)
	}
	log.Info().Str("user_id", session.userID.String()).Str("peer", session.peerBaseURL).Int64("bytes", session.archiveSize).Msg("buddy: archive pushed via incoming tunnel")
	return session.Result(peerTotal), true, nil
}

func (s *BuddyService) pushViaOutgoingTunnel(session *buddyPushSession) (PushResult, bool, error) {
	if s.tunnelClient == nil {
		return PushResult{}, false, nil
	}
	tr := s.tunnelClient.HTTPTransport()
	if tr == nil {
		return PushResult{}, false, nil
	}

	log.Info().Str("user_id", session.userID.String()).Str("peer", session.peerBaseURL).Int64("archive_bytes", session.archiveSize).Msg("buddy: pushing via outgoing tunnel")
	peerTotal, err := session.doPush(newBuddyTunnelHTTPClient(tr), "http://tunnel-peer/api/v1/backup/buddy/receive")
	if err != nil {
		log.Error().Err(err).Str("peer", session.peerBaseURL).Int64("bytes", session.archiveSize).Msg("buddy: outgoing tunnel push failed")
		return PushResult{}, true, fmt.Errorf("buddy push (outgoing tunnel): %w", err)
	}
	log.Info().Str("user_id", session.userID.String()).Str("peer", session.peerBaseURL).Int64("bytes", session.archiveSize).Msg("buddy: archive pushed via outgoing tunnel")
	return session.Result(peerTotal), true, nil
}

func (s *BuddyService) pushDirect(session *buddyPushSession) (PushResult, error) {
	log.Info().Str("user_id", session.userID.String()).Str("peer", session.peerBaseURL).Int64("archive_bytes", session.archiveSize).Msg("buddy: pushing via direct HTTPS (no tunnel active)")
	uploadBase := fetchPeerDirectUploadURL(session.ctx, session.peerBaseURL)
	if !strings.HasPrefix(uploadBase, "https://") && !strings.HasPrefix(uploadBase, "http://") {
		return PushResult{}, fmt.Errorf("buddy push: peer URL must use HTTPS")
	}

	uploadEndpoint := strings.TrimRight(uploadBase, "/") + "/api/v1/backup/buddy/receive"
	log.Info().Str("upload_endpoint", uploadEndpoint).Int64("archive_bytes", session.archiveSize).Msg("buddy: pushing archive (direct)")
	peerTotal, err := session.doPush(buddyHTTPClient, uploadEndpoint)
	if err != nil {
		return PushResult{}, fmt.Errorf("buddy push: %w", err)
	}
	log.Info().Str("user_id", session.userID.String()).Str("peer", session.peerBaseURL).Int64("bytes", session.archiveSize).Msg("buddy: archive pushed")
	return session.Result(peerTotal), nil
}

func (s *BuddyService) Receive(ctx context.Context, receiverUserID uuid.UUID, r io.Reader) (*BuddyArchive, error) {
	if s.root == "" {
		return nil, fmt.Errorf("buddy receive: backup storage not available on this instance")
	}
	dir, err := s.buddyDir(receiverUserID)
	if err != nil {
		return nil, err
	}

	filename := time.Now().UTC().Format("20060102T150405Z") + ".zip"
	path := filepath.Join(dir, filename)

	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0640)
	if err != nil {
		return nil, fmt.Errorf("buddy receive: create: %w", err)
	}
	defer f.Close()

	n, err := io.Copy(f, r)
	if err != nil {
		os.Remove(path)
		return nil, fmt.Errorf("buddy receive: write: %w", err)
	}

	log.Info().Str("receiver_user_id", receiverUserID.String()).Int64("bytes", n).Msg("buddy: archive received")
	return &BuddyArchive{
		Filename:   filename,
		SizeBytes:  n,
		ReceivedAt: time.Now().UTC(),
	}, nil
}

// ListReceived returns archives stored for userID (the local receiving user), newest first.
func (s *BuddyService) ListReceived(userID uuid.UUID) ([]BuddyArchive, error) {
	if s.root == "" {
		// BACKUPS_ROOT not configured on this instance — no received archives.
		return []BuddyArchive{}, nil
	}
	dir, err := s.buddyDir(userID)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []BuddyArchive{}, nil
		}
		return nil, fmt.Errorf("buddy: readdir: %w", err)
	}

	var archives []BuddyArchive
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".zip" {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		archives = append(archives, BuddyArchive{
			Filename:   e.Name(),
			SizeBytes:  fi.Size(),
			ReceivedAt: fi.ModTime().UTC(),
		})
	}
	sort.Slice(archives, func(i, j int) bool {
		return archives[i].ReceivedAt.After(archives[j].ReceivedAt)
	})
	return archives, nil
}

// DownloadReceived opens the named received archive for reading.
func (s *BuddyService) DownloadReceived(userID uuid.UUID, filename string) (io.ReadCloser, int64, error) {
	if !isValidArchiveName(filename) {
		return nil, 0, fmt.Errorf("buddy: invalid filename")
	}
	dir, err := s.buddyDir(userID)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(filepath.Join(dir, filename))
	if err != nil {
		return nil, 0, fmt.Errorf("buddy: open: %w", err)
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, fmt.Errorf("buddy: stat: %w", err)
	}
	return f, fi.Size(), nil
}

// TotalStoredBytes returns the sum of all received archive sizes for userID.
// Returns 0 if the buddy directory does not exist yet.
func (s *BuddyService) TotalStoredBytes(userID uuid.UUID) (int64, error) {
	archives, err := s.ListReceived(userID)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, a := range archives {
		total += a.SizeBytes
	}
	return total, nil
}

// DeleteReceived removes the named received archive.
func (s *BuddyService) DeleteReceived(userID uuid.UUID, filename string) error {
	if !isValidArchiveName(filename) {
		return fmt.Errorf("buddy: invalid filename")
	}
	dir, err := s.buddyDir(userID)
	if err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(dir, filename)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("buddy: delete: %w", err)
	}
	return nil
}

// countingReader wraps an io.Reader and atomically increments *counter by the
// number of bytes read. Used to track upload progress in Push.
type countingReader struct {
	r       io.Reader
	counter *int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if n > 0 {
		atomic.AddInt64(c.counter, int64(n))
	}
	return n, err
}
