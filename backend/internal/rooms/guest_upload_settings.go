package rooms

import "strconv"

func parsePositiveInt(raw string, fallback int) int {
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return fallback
	}
	return value
}

func parsePositiveInt64(raw string, fallback int64) int64 {
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1 {
		return fallback
	}
	return value
}
