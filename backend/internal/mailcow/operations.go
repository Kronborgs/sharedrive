package mailcow

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/yourname/privatedrive/internal/httputil"
)

func (h *Accounts) Operation(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		owner, ok := accountOwner(w, r)
		if !ok || !h.requireModule(w, r) {
			return
		}
		arguments, ok := readOperationArguments(w, r)
		if !ok {
			return
		}
		account, err := h.store.load(r.Context(), owner)
		if errors.Is(err, errNotConnected) {
			httputil.RespondError(w, http.StatusNotFound, "No Mailcow account is connected")
			return
		}
		if err != nil {
			accountError(w)
			return
		}
		password, err := h.aead.Open(nil, nil, account.encryptedPassword, accountAAD(owner, account.accountSummary))
		if err != nil {
			accountError(w)
			return
		}
		result, ok := h.probe.operation(w, r, name, account.Host, credentials{Username: account.Username, Password: string(password)}, arguments)
		if ok {
			httputil.Respond(w, http.StatusOK, result)
		}
	}
}

func readOperationArguments(w http.ResponseWriter, r *http.Request) (json.RawMessage, bool) {
	if r.Method == http.MethodGet {
		return nil, true
	}
	if !isJSON(r) {
		httputil.RespondError(w, http.StatusUnsupportedMediaType, "Mailcow requests must use application/json")
		return nil, false
	}
	var arguments json.RawMessage
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
	if decoder.Decode(&arguments) != nil || decoder.Decode(new(json.RawMessage)) != io.EOF {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid Mailcow request")
		return nil, false
	}
	return arguments, true
}
