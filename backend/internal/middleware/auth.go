package middleware

import (
	"context"
	"net/http"
"strings"

"github.com/jackc/pgx/v5/pgxpool"

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

// RequireProductAccess blocks authenticated users who have no access to a product.
// Limited and full access are both allowed here; individual handlers retain their
// existing resource-level permission checks.
func RequireProductAccess(db *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			account := UserFromContext(r.Context())
			if account == nil || account.IsAdmin() { next.ServeHTTP(w, r); return }
			product := productForPath(r.URL.Path)
			if product == "" || productAccessAllowed(r, db, account, product) { next.ServeHTTP(w, r); return }
			http.Error(w, `{"error":{"code":"FORBIDDEN","message":"Product access is disabled."}}`, http.StatusForbidden)
		})
	}
}

func productForPath(path string) string {
	switch {
	case strings.HasPrefix(path, "/api/v1/rooms"):
		return "rooms"
	case strings.HasPrefix(path, "/api/v1/notes"):
		return "notes"
	case strings.HasPrefix(path, "/api/v1/files") && strings.Contains(path, "/playlist"):
		return "music"
	case strings.HasPrefix(path, "/api/v1/files"):
		return "files"
	default:
		return ""
	}
}

func productAccessAllowed(r *http.Request, db *pgxpool.Pool, account *user.User, product string) bool {
	var level string
	if err := db.QueryRow(r.Context(), `SELECT access_level FROM user_product_access WHERE user_id=$1 AND product=$2`, account.ID, product).Scan(&level); err != nil {
		return product != "rooms" || account.RoomsAccessEnabled
	}
	return level != "none"
}
