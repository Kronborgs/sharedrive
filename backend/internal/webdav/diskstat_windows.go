//go:build windows

package webdav

// diskStats is not implemented on Windows; always returns (0, 0).
func diskStats(_ string) (total, free int64) {
	return 0, 0
}
