package backup

import (
	"bytes"
	"context"
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

// BuddyService handles the secondary backup layer — push/receive between
// two Sharedrive instances.
//
// Push: stream an encrypted archive to a peer server over HTTPS.
// Receive: accept an archive pushed from a peer and store it on disk.
// Archives pushed to this server are stored under BACKUPS_ROOT/buddy/<senderUserID>/.
type BuddyService struct {
	root    string
	backups *Service
}

// NewBuddyService creates a BuddyService.
func NewBuddyService(root string, backups *Service) *BuddyService {
	return &BuddyService{root: root, backups: backups}
}

// BuddyArchive describes an archive received from a peer.
type BuddyArchive struct {
	Filename     string    `json:"filename"`
	SenderUserID string    `json:"sender_user_id"`
	SizeBytes    int64     `json:"size_bytes"`
	ReceivedAt   time.Time `json:"received_at"`
}

// buddyDir returns (and creates) the per-sender directory for received archives.
func (s *BuddyService) buddyDir(senderUserID uuid.UUID) (string, error) {
	dir := filepath.Join(s.root, "buddy", senderUserID.String())
	if err := os.MkdirAll(dir, 0750); err != nil {
		return "", fmt.Errorf("buddy: mkdir: %w", err)
	}
	return dir, nil
}

// Push exports the user's archive to a peer Sharedrive server.
// buddyURL is the base URL of the peer; buddySecret is the pre-shared bearer token.
// folderIDs restricts scope; pass nil to include all files.
func (s *BuddyService) Push(ctx context.Context, userID uuid.UUID, rawToken string, folderIDs []uuid.UUID, buddyURL, buddySecret string) error {
	// Export to a temp file first — multipart needs io.ReaderAt/Seeker semantics.
	tmp, err := os.CreateTemp("", "shdbak-buddy-push-*")
	if err != nil {
		return fmt.Errorf("buddy push: create temp: %w", err)
	}
	defer func() {
		tmp.Close()
		os.Remove(tmp.Name())
	}()

	if err := s.backups.Export(ctx, tmp, userID, rawToken, folderIDs); err != nil {
		return fmt.Errorf("buddy push: export: %w", err)
	}

	fi, err := tmp.Stat()
	if err != nil {
		return fmt.Errorf("buddy push: stat: %w", err)
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return fmt.Errorf("buddy push: seek: %w", err)
	}

	// Assemble multipart body.
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("user_id", userID.String())
	archiveName := time.Now().UTC().Format("20060102T150405Z") + ".shdbak"
	fw, err := mw.CreateFormFile("file", archiveName)
	if err != nil {
		return fmt.Errorf("buddy push: form file: %w", err)
	}
	if _, err := io.CopyN(fw, tmp, fi.Size()); err != nil {
		return fmt.Errorf("buddy push: copy: %w", err)
	}
	mw.Close()

	endpoint := strings.TrimRight(buddyURL, "/") + "/api/v1/backup/buddy/receive"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return fmt.Errorf("buddy push: request: %w", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+buddySecret)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("buddy push: http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("buddy push: peer returned HTTP %d", resp.StatusCode)
	}

	log.Info().Str("user_id", userID.String()).Str("peer", buddyURL).Msg("buddy: archive pushed")
	return nil
}

// Receive stores an archive sent from a peer server.
// senderUserID is the UUID of the user on the sending server.
func (s *BuddyService) Receive(ctx context.Context, senderUserID uuid.UUID, r io.Reader) (*BuddyArchive, error) {
	dir, err := s.buddyDir(senderUserID)
	if err != nil {
		return nil, err
	}

	filename := time.Now().UTC().Format("20060102T150405Z") + ".shdbak"
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

	log.Info().Str("sender_user_id", senderUserID.String()).Int64("bytes", n).Msg("buddy: archive received")
	return &BuddyArchive{
		Filename:     filename,
		SenderUserID: senderUserID.String(),
		SizeBytes:    n,
		ReceivedAt:   time.Now().UTC(),
	}, nil
}

// ListReceived returns archives stored for senderUserID, newest first.
// senderUserID is the UUID of the user on the originating server.
func (s *BuddyService) ListReceived(senderUserID uuid.UUID) ([]BuddyArchive, error) {
	dir, err := s.buddyDir(senderUserID)
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
		if e.IsDir() || filepath.Ext(e.Name()) != ".shdbak" {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		archives = append(archives, BuddyArchive{
			Filename:     e.Name(),
			SenderUserID: senderUserID.String(),
			SizeBytes:    fi.Size(),
			ReceivedAt:   fi.ModTime().UTC(),
		})
	}
	sort.Slice(archives, func(i, j int) bool {
		return archives[i].ReceivedAt.After(archives[j].ReceivedAt)
	})
	return archives, nil
}

// DownloadReceived opens the named received archive for reading.
func (s *BuddyService) DownloadReceived(senderUserID uuid.UUID, filename string) (io.ReadCloser, int64, error) {
	if !isValidArchiveName(filename) {
		return nil, 0, fmt.Errorf("buddy: invalid filename")
	}
	dir, err := s.buddyDir(senderUserID)
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
func (s *BuddyService) DeleteReceived(senderUserID uuid.UUID, filename string) error {
	if !isValidArchiveName(filename) {
		return fmt.Errorf("buddy: invalid filename")
	}
	dir, err := s.buddyDir(senderUserID)
	if err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(dir, filename)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("buddy: delete: %w", err)
	}
	return nil
}
