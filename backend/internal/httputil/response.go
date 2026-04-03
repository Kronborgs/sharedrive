package httputil

import (
	"encoding/json"
	"net/http"
)

type apiResponse struct {
	Data  any       `json:"data"`
	Error *apiError `json:"error"`
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Respond writes a successful JSON response with the given status code and data.
func Respond(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(apiResponse{Data: data, Error: nil})
}

// RespondError writes a JSON error response. The code defaults to "ERROR" when empty.
func RespondError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(apiResponse{
		Data:  nil,
		Error: &apiError{Code: "ERROR", Message: message},
	})
}
