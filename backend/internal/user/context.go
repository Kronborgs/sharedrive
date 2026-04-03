package user

import "context"

// ctxKey is an unexported type to prevent context key collisions with other packages.
type ctxKey string

const sessionUserKey ctxKey = "sessionUser"

// WithUser returns a new context with u stored as the authenticated user.
// Called by the auth middleware after successfully validating a session.
func WithUser(ctx context.Context, u *User) context.Context {
	return context.WithValue(ctx, sessionUserKey, u)
}

// UserFromContext retrieves the authenticated *User from ctx.
// Returns nil when no user is set (unauthenticated request).
func UserFromContext(ctx context.Context) *User {
	u, _ := ctx.Value(sessionUserKey).(*User)
	return u
}
