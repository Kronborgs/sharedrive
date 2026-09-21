package rooms

import (
	"net/http"
	"strings"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
)

type pushSubscriptionRequest struct {
	pushSubscriptionPayload
	Locale string `json:"locale"`
}

func (handler *Handler) GetPushConfig(w http.ResponseWriter, request *http.Request) {
	response := map[string]any{"enabled": handler.push.isEnabled()}
	if handler.push.isEnabled() { response["public_key"] = handler.push.publicKey }
	httputil.Respond(w, http.StatusOK, response)
}

func (handler *Handler) SavePushSubscription(w http.ResponseWriter, request *http.Request) {
	if !handler.push.isEnabled() {
		httputil.RespondError(w, http.StatusServiceUnavailable, "push notifications are not configured")
		return
	}
	var input pushSubscriptionRequest
	if !decodeRequest(w, request, &input) { return }
	user := middleware.UserFromContext(request.Context())
	if err := handler.push.saveSubscription(request.Context(), user.ID, input.pushSubscriptionPayload, input.Locale); err != nil {
		if strings.Contains(err.Error(), "invalid push") || strings.Contains(err.Error(), "unsupported push") {
			httputil.RespondError(w, http.StatusBadRequest, err.Error())
			return
		}
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusNoContent, nil)
}

func (handler *Handler) DeletePushSubscription(w http.ResponseWriter, request *http.Request) {
	if !handler.push.isEnabled() {
		httputil.RespondError(w, http.StatusServiceUnavailable, "push notifications are not configured")
		return
	}
	var input struct { Endpoint string `json:"endpoint"` }
	if !decodeRequest(w, request, &input) { return }
	user := middleware.UserFromContext(request.Context())
	if err := handler.push.deleteSubscription(request.Context(), user.ID, strings.TrimSpace(input.Endpoint)); err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusNoContent, nil)
}

