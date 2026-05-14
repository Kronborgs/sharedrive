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
		return baseURL
	}
	resp, err := buddyHTTPClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		return baseURL
	}
	defer resp.Body.Close()
	var info BuddyServerInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil || info.DirectUploadURL == "" {
		return baseURL
	}
	log.Info().Str("base_url", baseURL).Str("upload_url", info.DirectUploadURL).Msg("buddy: using peer direct upload URL")
	return info.DirectUploadURL
}

// Push: stream an encrypted archive to a peer server over HTTPS.
// Receive: accept an archive pushed from a peer and store it on disk.
// Archives pushed to this server are stored under BACKUPS_ROOT/buddy/<senderUserID>/.
type BuddyService struct {
	root      string
	backups   *Service
	tunnelMgr *TunnelManager // optional — enables tunnel-based push to CGNAT peers
}

// NewBuddyService creates a BuddyService.
func NewBuddyService(root string, backups *Service) *BuddyService {
	return &BuddyService{root: root, backups: backups}
}

// SetTunnelManager wires the reverse-tunnel manager so Push can route through
// an active tunnel when the peer is behind CGNAT.
func (s *BuddyService) SetTunnelManager(tm *TunnelManager) { s.tunnelMgr = tm }

// BuddyArchive describes an archive received from a peer.
type BuddyArchive struct {
	Filename   string    `json:"filename"`
	SizeBytes  int64     `json:"size_bytes"`
	ReceivedAt time.Time `json:"received_at"`
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
// Returns the number of bytes in the pushed archive.
func (s *BuddyService) Push(ctx context.Context, userID uuid.UUID, rawToken string, folderIDs []uuid.UUID, peerBaseURL, peerUserID, peerToken string) (int64, error) {
	// Export to a temp file first — multipart needs io.ReaderAt/Seeker semantics.
	tmp, err := os.CreateTemp("", "shdbak-buddy-push-*")
	if err != nil {
		return 0, fmt.Errorf("buddy push: create temp: %w", err)
	}
	defer func() {
		tmp.Close()
		os.Remove(tmp.Name())
	}()

	if err := s.backups.Export(ctx, tmp, userID, rawToken, folderIDs); err != nil {
		return 0, fmt.Errorf("buddy push: export: %w", err)
	}

	fi, err := tmp.Stat()
	if err != nil {
		return 0, fmt.Errorf("buddy push: stat: %w", err)
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return 0, fmt.Errorf("buddy push: seek: %w", err)
	}

	// Assemble multipart body.
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("receiver_user_id", peerUserID)
	archiveName := time.Now().UTC().Format("20060102T150405Z") + ".zip"
	fw, err := mw.CreateFormFile("file", archiveName)
	if err != nil {
		return 0, fmt.Errorf("buddy push: form file: %w", err)
	}
	if _, err := io.CopyN(fw, tmp, fi.Size()); err != nil {
		return 0, fmt.Errorf("buddy push: copy: %w", err)
	}
	mw.Close()

	receiveEndpoint := strings.TrimRight(peerBaseURL, "/") + "/api/v1/backup/buddy/receive"
	if !strings.HasPrefix(receiveEndpoint, "https://") {
		return 0, fmt.Errorf("buddy push: peer URL must use HTTPS")
	}

	// If there is an active reverse tunnel to this peer, push through it.
	// The tunnel bypasses CGNAT and Cloudflare upload limits entirely.
	var httpClient *http.Client
	if s.tunnelMgr != nil {
		if tr := s.tunnelMgr.HTTPTransport(userID); tr != nil {
			httpClient = &http.Client{Transport: tr, Timeout: 10 * time.Minute}
			// Use a plain http:// URL — traffic is already tunnelled (no extra TLS needed).
			uploadEndpoint := "http://tunnel-peer/api/v1/backup/buddy/receive"
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadEndpoint, &body)
			if err != nil {
				return 0, fmt.Errorf("buddy push (tunnel): request: %w", err)
			}
			req.Header.Set("Content-Type", mw.FormDataContentType())
			req.Header.Set("Authorization", "Bearer "+peerToken)
			resp, err := httpClient.Do(req)
			if err != nil {
				return 0, fmt.Errorf("buddy push (tunnel): http: %w", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
				msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
				detail := strings.TrimSpace(string(msg))
				if resp.StatusCode == http.StatusServiceUnavailable {
					return 0, fmt.Errorf("buddy push: modtager-serveren har ikke backup-lager konfigureret (sæt BACKUPS_ROOT på peer-instansen)")
				}
				if detail == "" {
					detail = "no details from peer"
				}
				return 0, fmt.Errorf("buddy push (tunnel): peer returnerede HTTP %d: %s", resp.StatusCode, detail)
			}
			log.Info().Str("user_id", userID.String()).Str("peer", peerBaseURL).Int64("bytes", fi.Size()).Msg("buddy: archive pushed via tunnel")
			return fi.Size(), nil
		}
	}

	// No tunnel — fall through to direct HTTPS push.
	// Use the peer's direct upload URL if configured — bypasses Cloudflare size limits.
	// We still validate the base URL above; the upload URL is only used for the actual POST.
	uploadBase := fetchPeerDirectUploadURL(ctx, peerBaseURL)
	uploadEndpoint := strings.TrimRight(uploadBase, "/") + "/api/v1/backup/buddy/receive"

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadEndpoint, &body)
	if err != nil {
		return 0, fmt.Errorf("buddy push: request: %w", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+peerToken)

	resp, err := buddyHTTPClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("buddy push: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		// Read up to 512 bytes of the body for a diagnostic message.
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		detail := strings.TrimSpace(string(msg))
		if detail == "" {
			detail = "no details from peer"
		}
		if resp.StatusCode == http.StatusServiceUnavailable {
			return 0, fmt.Errorf("buddy push: modtager-serveren har ikke backup-lager konfigureret (sæt BACKUPS_ROOT på peer-instansen)")
		}
		return 0, fmt.Errorf("buddy push: peer returnerede HTTP %d: %s", resp.StatusCode, detail)
	}

	log.Info().Str("user_id", userID.String()).Str("peer", peerBaseURL).Int64("bytes", fi.Size()).Msg("buddy: archive pushed")
	return fi.Size(), nil
}

// Receive stores an archive pushed from a peer under the receiving user's directory.
// receiverUserID is the UUID of the local user who owns the receive token.
func (s *BuddyService) Receive(ctx context.Context, receiverUserID uuid.UUID, r io.Reader) (*BuddyArchive, error) {
	if s.root == "" {
		return nil, fmt.Errorf("buddy receive: BACKUPS_ROOT not configured on this instance")
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
