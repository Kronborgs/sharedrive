package rooms

import (
	"net/http"
	"strings"
	"time"

	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
	"github.com/yourname/privatedrive/internal/ratelimit"
)

const pushNotificationsNotConfigured = "push notifications are not configured"

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
		httputil.RespondError(w, http.StatusServiceUnavailable, pushNotificationsNotConfigured)
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

func (handler *Handler) SendTestPush(w http.ResponseWriter, request *http.Request) {
	if !handler.push.isEnabled() {
		httputil.RespondError(w, http.StatusServiceUnavailable, pushNotificationsNotConfigured)
		return
	}
	user := middleware.UserFromContext(request.Context())
	allowed, _, _, limitErr := handler.limiter.Allow(request.Context(), ratelimit.KeyUserRoomPushTest, user.ID.String(), 3, 10*time.Minute)
	if limitErr != nil || !allowed {
		httputil.RespondError(w, http.StatusTooManyRequests, "push test rate limit exceeded")
		return
	}
	count, err := handler.push.sendTest(request.Context(), user.ID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]int{"subscriptions": count})
}

func (handler *Handler) DeletePushSubscription(w http.ResponseWriter, request *http.Request) {
	if !handler.push.isEnabled() {
		httputil.RespondError(w, http.StatusServiceUnavailable, pushNotificationsNotConfigured)
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

