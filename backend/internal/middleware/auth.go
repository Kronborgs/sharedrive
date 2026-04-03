package middleware

import (
	"context"
	"net/http"

	"github.com/yourname/privatedrive/internal/user"
)

type authContextKey string

const (
	sessionUserKey   authContextKey = "sessionUser"
	isSupportModeKey authContextKey = "isSupportMode"
)

// WithUser stores the authenticated user in the request context.
// Delegates to user.WithUser so that the user package itself can retrieve it
// without creating a circular import.
func WithUser(ctx context.Context, u *user.User) context.Context {
	return user.WithUser(ctx, u)
}

// UserFromContext retrieves the authenticated user from context. Returns nil if
// not authenticated.
func UserFromContext(ctx context.Context) *user.User {
	return user.UserFromContext(ctx)
}

// WithSupportMode marks the request context as an admin support-access session.
func WithSupportMode(ctx context.Context) context.Context {
	return context.WithValue(ctx, isSupportModeKey, true)
}

// IsSupportMode returns true when the request is an admin support-access session.
func IsSupportMode(ctx context.Context) bool {
	v, _ := ctx.Value(isSupportModeKey).(bool)
	return v
}

// RequireAuth is middleware that rejects unauthenticated requests with 401.
// The session resolution (cookie → DB lookup) is performed by the auth package
// and the user is expected to already be set in context by that point.
func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if UserFromContext(r.Context()) == nil {
			http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"Authentication required."}}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireAdmin rejects requests from non-admin users with 403.
func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u := UserFromContext(r.Context())
		if u == nil {
			http.Error(w, `{"error":{"code":"UNAUTHORIZED","message":"Authentication required."}}`, http.StatusUnauthorized)
			return
		}
		if u.Role != "admin" {
			http.Error(w, `{"error":{"code":"FORBIDDEN","message":"Admin access required."}}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
