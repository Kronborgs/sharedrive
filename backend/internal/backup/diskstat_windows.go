//go:build windows

package backup

func diskStats(_ string) (total, free int64) {
	return 0, 0
}
