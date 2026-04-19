package files

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// ── Encryption constants ──────────────────────────────────────────────────────
//
// On-disk format when FILE_ENCRYPT_KEY is set:
//
//	[8 bytes magic] [8 bytes uint64-LE plaintext-size]
//	For each 1-MiB chunk:
//	    [12 bytes GCM nonce] [plaintext_chunk_len + 16 bytes GCM ciphertext+tag]
//
// Backward compat: files that do NOT start with encMagic are served as-is.

const (
	encMagicStr   = "\x00SHENC1\x00" // 8 bytes
	encHdrSize    = 16               // magic(8) + plaintext_size(8)
	encChunkPlain = 1 << 20          // 1 MiB of plaintext per chunk
	encNonceSize  = 12               // GCM standard nonce
	encTagSize    = 16               // GCM authentication tag
	// Encrypted chunk on disk: nonce(12) + ciphertext(plaintext+tag=n+16)
	encChunkEnc = encNonceSize + encChunkPlain + encTagSize // 1 048 604 bytes for full chunks
)

var encMagic = [8]byte{0, 'S', 'H', 'E', 'N', 'C', '1', 0}

// Storage manages raw file bytes on disk using UUID-sharded paths.
// Path structure: {root}/{first-2-chars-of-uuid}/{full-uuid}
//
// When encKey is non-nil, newly written files are AES-256-GCM encrypted.
// Open() transparently decrypts files that begin with the magic header, so
// files written before encryption was enabled are still served correctly.
type Storage struct {
	root   string
	encKey []byte // nil = no encryption; 32 bytes = AES-256
}

// NewStorage creates a Storage. root must exist and be writable.
// encKeyHex is a 64-char hex string (32 bytes); pass "" to disable encryption.
func NewStorage(root string, encKeyHex ...string) *Storage {
	s := &Storage{root: root}
	if len(encKeyHex) > 0 && len(encKeyHex[0]) == 64 {
		key := make([]byte, 32)
		for i := 0; i < 32; i++ {
			b := encKeyHex[0][i*2 : i*2+2]
			var v byte
			fmt.Sscanf(b, "%02x", &v)
			key[i] = v
		}
		s.encKey = key
	}
	return s
}

// Path returns the absolute storage path for a given UUID.
func (s *Storage) Path(id string) string {
	if len(id) < 2 {
		return filepath.Join(s.root, "00", id)
	}
	return filepath.Join(s.root, id[:2], id)
}

// Write stores r into the sharded path for id, creating parent directories as
// needed. Returns the number of PLAINTEXT bytes written.
// When an encryption key is configured the data is AES-256-GCM encrypted.
func (s *Storage) Write(id string, r io.Reader) (int64, error) {
	dest := s.Path(id)
	if err := os.MkdirAll(filepath.Dir(dest), 0750); err != nil {
		return 0, fmt.Errorf("storage: mkdir: %w", err)
	}
	f, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0640)
	if err != nil {
		return 0, fmt.Errorf("storage: open: %w", err)
	}
	defer f.Close()

	if len(s.encKey) == 0 {
		n, err := io.Copy(f, r)
		if err != nil {
			return n, fmt.Errorf("storage: write: %w", err)
		}
		return n, nil
	}

	// ── Encrypted write ───────────────────────────────────────────────────
	block, err := aes.NewCipher(s.encKey)
	if err != nil {
		return 0, fmt.Errorf("storage: cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return 0, fmt.Errorf("storage: gcm: %w", err)
	}

	// Write magic header; patch plaintext size after streaming all chunks.
	if _, err := f.Write(encMagic[:]); err != nil {
		return 0, fmt.Errorf("storage: write magic: %w", err)
	}
	if _, err := f.Write(make([]byte, 8)); err != nil { // placeholder for size
		return 0, fmt.Errorf("storage: write size placeholder: %w", err)
	}

	buf := make([]byte, encChunkPlain)
	var total int64
	for {
		n, readErr := io.ReadFull(r, buf)
		if n > 0 {
			nonce := make([]byte, gcm.NonceSize())
			if _, err := rand.Read(nonce); err != nil {
				return total, fmt.Errorf("storage: nonce: %w", err)
			}
			ct := gcm.Seal(nil, nonce, buf[:n], nil) // appends 16-byte tag
			if _, err := f.Write(nonce); err != nil {
				return total, fmt.Errorf("storage: write nonce: %w", err)
			}
			if _, err := f.Write(ct); err != nil {
				return total, fmt.Errorf("storage: write chunk: %w", err)
			}
			total += int64(n)
		}
		if readErr == io.EOF || readErr == io.ErrUnexpectedEOF {
			break
		}
		if readErr != nil {
			return total, fmt.Errorf("storage: read: %w", readErr)
		}
	}

	// Patch plaintext size at byte offset 8 (after magic).
	var sizeBuf [8]byte
	binary.LittleEndian.PutUint64(sizeBuf[:], uint64(total))
	if _, err := f.Seek(8, io.SeekStart); err != nil {
		return total, fmt.Errorf("storage: seek for size patch: %w", err)
	}
	if _, err := f.Write(sizeBuf[:]); err != nil {
		return total, fmt.Errorf("storage: write size: %w", err)
	}
	return total, nil
}

// Open returns a ReadSeekCloser for reading the stored file.
// If the file starts with the encryption magic it is decrypted on the fly;
// unencrypted files (written before FILE_ENCRYPT_KEY was set) are returned as-is.
// Caller is responsible for closing the returned reader.
func (s *Storage) Open(id string) (io.ReadSeekCloser, error) {
	f, err := os.Open(s.Path(id))
	if err != nil {
		return nil, err
	}

	// Peek at the first 8 bytes to detect the encryption magic.
	var hdr [8]byte
	if _, err := io.ReadFull(f, hdr[:]); err != nil {
		// Empty or very small file — return raw.
		_, _ = f.Seek(0, io.SeekStart)
		return f, nil
	}
	if hdr != encMagic || len(s.encKey) == 0 {
		// Not encrypted (or key not configured) — return raw from the start.
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			f.Close()
			return nil, err
		}
		return f, nil
	}

	// Read plaintext size from header.
	var sizeBuf [8]byte
	if _, err := io.ReadFull(f, sizeBuf[:]); err != nil {
		f.Close()
		return nil, fmt.Errorf("storage: read enc header: %w", err)
	}
	plainSize := int64(binary.LittleEndian.Uint64(sizeBuf[:]))

	block, err := aes.NewCipher(s.encKey)
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("storage: cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("storage: gcm: %w", err)
	}

	return &decReader{f: f, gcm: gcm, plainSize: plainSize}, nil
}

// Delete removes the stored file. Returns nil if the file does not exist.
func (s *Storage) Delete(id string) error {
	if err := os.Remove(s.Path(id)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("storage: delete %s: %w", id, err)
	}
	return nil
}

// Exists reports whether the stored file exists on disk.
func (s *Storage) Exists(id string) bool {
	_, err := os.Stat(s.Path(id))
	return err == nil
}

// ── Decrypting reader ─────────────────────────────────────────────────────────

// decReader decrypts a chunked AES-256-GCM file on the fly and implements
// io.ReadSeekCloser. Seeking is O(1): the position of chunk i in the
// encrypted file is deterministic since all full chunks occupy the same
// number of bytes (encChunkEnc).
type decReader struct {
	f         *os.File
	gcm       cipher.AEAD
	plainSize int64
	plainPos  int64 // current plaintext position
	buf       []byte
	bufOff    int // read position inside buf
}

var errSeekRange = errors.New("storage: seek out of range")

func (r *decReader) Read(p []byte) (int, error) {
	if r.plainPos >= r.plainSize {
		return 0, io.EOF
	}
	// Fill buffer from next chunk if current buffer is exhausted.
	if r.bufOff >= len(r.buf) {
		if err := r.readNextChunk(); err != nil {
			return 0, err
		}
	}
	n := copy(p, r.buf[r.bufOff:])
	r.bufOff += n
	r.plainPos += int64(n)
	return n, nil
}

func (r *decReader) readNextChunk() error {
	remaining := r.plainSize - r.plainPos
	if remaining <= 0 {
		return io.EOF
	}
	chunkPlain := int64(encChunkPlain)
	if remaining < chunkPlain {
		chunkPlain = remaining
	}

	nonce := make([]byte, r.gcm.NonceSize())
	if _, err := io.ReadFull(r.f, nonce); err != nil {
		return fmt.Errorf("storage: read nonce: %w", err)
	}
	ctLen := chunkPlain + int64(encTagSize)
	ct := make([]byte, ctLen)
	if _, err := io.ReadFull(r.f, ct); err != nil {
		return fmt.Errorf("storage: read chunk ct: %w", err)
	}
	pt, err := r.gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return fmt.Errorf("storage: decrypt chunk: %w", err)
	}
	r.buf = pt
	r.bufOff = 0
	return nil
}

func (r *decReader) Seek(offset int64, whence int) (int64, error) {
	var abs int64
	switch whence {
	case io.SeekStart:
		abs = offset
	case io.SeekCurrent:
		abs = r.plainPos + offset
	case io.SeekEnd:
		abs = r.plainSize + offset
	default:
		return r.plainPos, errors.New("storage: invalid whence")
	}
	if abs < 0 || abs > r.plainSize {
		return r.plainPos, errSeekRange
	}

	chunkIdx := abs / int64(encChunkPlain)
	chunkByte := int(abs % int64(encChunkPlain))

	// Seek the encrypted file to the start of chunk chunkIdx.
	// All full-size chunks occupy exactly encChunkEnc bytes.
	encOff := int64(encHdrSize) + chunkIdx*int64(encChunkEnc)
	if _, err := r.f.Seek(encOff, io.SeekStart); err != nil {
		return r.plainPos, fmt.Errorf("storage: seek file: %w", err)
	}

	// Set plainPos to start of this chunk so readNextChunk() computes the
	// correct remaining bytes for the last (possibly partial) chunk.
	r.plainPos = chunkIdx * int64(encChunkPlain)
	r.buf = nil
	r.bufOff = 0

	if err := r.readNextChunk(); err != nil && !errors.Is(err, io.EOF) {
		return r.plainPos, err
	}
	r.bufOff = chunkByte
	r.plainPos = abs
	return abs, nil
}

func (r *decReader) Close() error { return r.f.Close() }
