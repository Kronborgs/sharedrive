package backup

import (
	"bytes"
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
type BuddyService struct {
	root         string
	backups      *Service
	tunnelMgr    *TunnelManager // optional — enables tunnel-based push to CGNAT peers
	tunnelClient *TunnelClient  // optional — enables push via outgoing tunnel (bypasses peer Cloudflare)
}

// NewBuddyService creates a BuddyService.
func NewBuddyService(root string, backups *Service) *BuddyService {
	return &BuddyService{root: root, backups: backups}
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
func (s *BuddyService) Push(ctx context.Context, userID uuid.UUID, rawToken string, folderIDs []uuid.UUID, peerBaseURL, peerUserID, peerToken string) (PushResult, error) {
	// Export to a temp file first — multipart needs io.ReaderAt/Seeker semantics.
	tmp, err := os.CreateTemp("", "shdbak-buddy-push-*")
	if err != nil {
		return PushResult{}, fmt.Errorf("buddy push: create temp: %w", err)
	}
	defer func() {
		tmp.Close()
		os.Remove(tmp.Name())
	}()

	if err := s.backups.Export(ctx, tmp, userID, rawToken, folderIDs); err != nil {
		return PushResult{}, fmt.Errorf("buddy push: export: %w", err)
	}

	fi, err := tmp.Stat()
	if err != nil {
		return PushResult{}, fmt.Errorf("buddy push: stat: %w", err)
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return PushResult{}, fmt.Errorf("buddy push: seek: %w", err)
	}

	archiveName := time.Now().UTC().Format("20060102T150405Z") + ".zip"

	// buildBody creates a fresh multipart body from tmp (caller must have seeked to 0 first).
	buildBody := func() (bytes.Buffer, *multipart.Writer, error) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		_ = mw.WriteField("receiver_user_id", peerUserID)
		fw, err := mw.CreateFormFile("file", archiveName)
		if err != nil {
			return buf, mw, err
		}
		if _, err := io.CopyN(fw, tmp, fi.Size()); err != nil {
			return buf, mw, err
		}
		mw.Close()
		return buf, mw, nil
	}

	// setContentLength sets Content-Length on a request so multipart parsers on the
	// receiving end can allocate correctly — critical when sending through the tunnel.
	setContentLength := func(req *http.Request, body *bytes.Buffer) {
		req.ContentLength = int64(body.Len())
	}

	receiveEndpoint := strings.TrimRight(peerBaseURL, "/") + "/api/v1/backup/buddy/receive"
	if !strings.HasPrefix(receiveEndpoint, "https://") {
		return PushResult{}, fmt.Errorf("buddy push: peer URL must use HTTPS")
	}

	// parseReceiveResponse reads the peer's JSON response to extract total_stored_bytes.
	parseReceiveResponse := func(r io.Reader) int64 {
		var resp BuddyArchive
		if err := json.NewDecoder(io.LimitReader(r, 4096)).Decode(&resp); err == nil {
			return resp.TotalStoredBytes
		}
		return 0
	}

	// If there is an active reverse tunnel to this peer, push through it.
	// The tunnel bypasses CGNAT and Cloudflare upload limits entirely.
	var httpClient *http.Client
	if s.tunnelMgr != nil {
		if tr := s.tunnelMgr.HTTPTransport(userID); tr != nil {
			httpClient = &http.Client{Transport: tr, Timeout: 10 * time.Minute}
			// Use a plain http:// URL — traffic is already tunnelled (no extra TLS needed).
			uploadEndpoint := "http://tunnel-peer/api/v1/backup/buddy/receive"
			if _, err := tmp.Seek(0, io.SeekStart); err != nil {
				return PushResult{}, fmt.Errorf("buddy push (tunnel): seek: %w", err)
			}
			body, mwb, err := buildBody()
			if err != nil {
				return PushResult{}, fmt.Errorf("buddy push (tunnel): build body: %w", err)
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadEndpoint, &body)
			if err != nil {
				return PushResult{}, fmt.Errorf("buddy push (tunnel): request: %w", err)
			}
			setContentLength(req, &body)
			req.Header.Set("Content-Type", mwb.FormDataContentType())
			req.Header.Set("Authorization", "Bearer "+peerToken)
			req.Header.Set("X-Buddy-Sender-User-ID", userID.String())
			resp, err := httpClient.Do(req)
			if err != nil {
				return PushResult{}, fmt.Errorf("buddy push (tunnel): http: %w", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
				msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
				detail := strings.TrimSpace(string(msg))
				if resp.StatusCode == http.StatusServiceUnavailable {
					return PushResult{}, ErrPeerStorageUnavailable
				}
				if detail == "" {
					detail = "no details from peer"
				}
				return PushResult{}, fmt.Errorf("buddy push (tunnel): peer returnerede HTTP %d: %s", resp.StatusCode, detail)
			}
			peerTotal := parseReceiveResponse(resp.Body)
			log.Info().Str("user_id", userID.String()).Str("peer", peerBaseURL).Int64("bytes", fi.Size()).Msg("buddy: archive pushed via tunnel")
			return PushResult{ArchiveBytes: fi.Size(), PeerTotalBytes: peerTotal}, nil
		}
	}

	// If there is an active outgoing tunnel (this instance connected to peer),
	// push through it — yamux is bidirectional so the peer's TunnelManager
	// accepts the stream and proxies it to the peer's local HTTP, bypassing
	// any Cloudflare upload limits on the peer side.
	// If the tunnel attempt fails with a transport error (e.g. peer not rebuilt yet),
	// fall through to direct push — do NOT give up on a recoverable failure.
	if s.tunnelClient != nil {
		if tr := s.tunnelClient.HTTPTransport(); tr != nil {
			tunnelHTTP := &http.Client{Transport: tr, Timeout: 10 * time.Minute}
			if _, err := tmp.Seek(0, io.SeekStart); err == nil {
				body, mwb, err := buildBody()
				if err == nil {
					uploadEndpoint := "http://tunnel-peer/api/v1/backup/buddy/receive"
					req, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadEndpoint, &body)
					if err == nil {
						setContentLength(req, &body)
						req.Header.Set("Content-Type", mwb.FormDataContentType())
						req.Header.Set("Authorization", "Bearer "+peerToken)
						req.Header.Set("X-Buddy-Sender-User-ID", userID.String())
						resp, err := tunnelHTTP.Do(req)
						if err == nil {
							defer resp.Body.Close()
							if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated {
								peerTotal := parseReceiveResponse(resp.Body)
								log.Info().Str("user_id", userID.String()).Str("peer", peerBaseURL).Int64("bytes", fi.Size()).Msg("buddy: archive pushed via outgoing tunnel")
								return PushResult{ArchiveBytes: fi.Size(), PeerTotalBytes: peerTotal}, nil
							}
							if resp.StatusCode == http.StatusServiceUnavailable {
								return PushResult{}, ErrPeerStorageUnavailable
							}
							// HTTP error from peer — return it
							msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
							detail := strings.TrimSpace(string(msg))
							if detail == "" {
								detail = "no details from peer"
							}
							return PushResult{}, fmt.Errorf("buddy push (outgoing tunnel): peer returnerede HTTP %d: %s", resp.StatusCode, detail)
						}
						// Transport error (stream closed, peer old version, etc.) — fall through
						log.Warn().Err(err).Str("peer", peerBaseURL).Msg("buddy: outgoing tunnel transport error, falling through to direct upload")
					}
				}
			}
		}
	}

	// No tunnel — fall through to direct HTTPS push.
	// Use the peer's direct upload URL if configured — bypasses Cloudflare size limits.
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return PushResult{}, fmt.Errorf("buddy push: seek for direct: %w", err)
	}
	body, mwb, err := buildBody()
	if err != nil {
		return PushResult{}, fmt.Errorf("buddy push: build body: %w", err)
	}
	uploadBase := fetchPeerDirectUploadURL(ctx, peerBaseURL)
	uploadEndpoint := strings.TrimRight(uploadBase, "/") + "/api/v1/backup/buddy/receive"
	log.Info().Str("upload_endpoint", uploadEndpoint).Int64("archive_bytes", fi.Size()).Msg("buddy: pushing archive (direct)")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadEndpoint, &body)
	if err != nil {
		return PushResult{}, fmt.Errorf("buddy push: request: %w", err)
	}
	setContentLength(req, &body)
	req.Header.Set("Content-Type", mwb.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+peerToken)
	req.Header.Set("X-Buddy-Sender-User-ID", userID.String())

	resp, err := buddyHTTPClient.Do(req)
	if err != nil {
		return PushResult{}, fmt.Errorf("buddy push: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		detail := strings.TrimSpace(string(msg))
		if detail == "" {
			detail = "no details from peer"
		}
		if resp.StatusCode == http.StatusServiceUnavailable {
			return PushResult{}, ErrPeerStorageUnavailable
		}
		return PushResult{}, fmt.Errorf("buddy push: peer returnerede HTTP %d: %s", resp.StatusCode, detail)
	}

	peerTotal := parseReceiveResponse(resp.Body)
	log.Info().Str("user_id", userID.String()).Str("peer", peerBaseURL).Int64("bytes", fi.Size()).Msg("buddy: archive pushed")
	return PushResult{ArchiveBytes: fi.Size(), PeerTotalBytes: peerTotal}, nil
}

// Receive stores an archive pushed from a peer under the receiving user's directory.
// receiverUserID is the UUID of the local user who owns the receive token.
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
