//go:build !windows

package webdav

import "syscall"

// diskStats returns (totalBytes, freeBytes) for the filesystem containing path.
// Returns (0, 0) if the stat fails.
func diskStats(path string) (total, free int64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0
	}
	total = int64(st.Blocks) * st.Bsize
	free = int64(st.Bfree) * st.Bsize
	return total, free
}
