//go:build !windows

package backup

import "syscall"

// diskStats returns (totalBytes, freeBytes) for the filesystem containing path.
func diskStats(path string) (total, free int64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0
	}
	return int64(st.Blocks) * st.Bsize, int64(st.Bfree) * st.Bsize
}
