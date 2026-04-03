package server

import (
	"encoding/json"
	"net/http"
)

// apiResponse is the standard envelope for all JSON API responses.
type apiResponse struct {
	Data  any        `json:"data"`
	Error *apiError  `json:"error"`
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// respond writes a successful JSON response.
func respond(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(apiResponse{Data: data, Error: nil})
}

// respondError writes a JSON error response. The HTTP status code is set
// explicitly so that upstream proxies can distinguish errors, but the
// client-facing error code and message are intentionally generic for
// sensitive operations (e.g. auth).
func respondError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(apiResponse{
		Data:  nil,
		Error: &apiError{Code: code, Message: message},
	})
}
