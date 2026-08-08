package notes

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
	"github.com/yourname/privatedrive/internal/ratelimit"
)

const (
	guestCookieName = "note_guest_session"
	guestSessionTTL = 24 * time.Hour
	maxNoteShares   = 100
)

type NoteMailer interface {
	SendNoteInvitation(ctx context.Context, toEmail, ownerName, noteTitle, permission, inviteLink, language string, expiresAt *time.Time) error
}

type SharingService struct {
	db           *pgxpool.Pool
	mailer       NoteMailer
	audit        audit.Logger
	limiter      *ratelimit.Limiter
	appURL       string
	secureCookie bool
}

type NoteShare struct {
	ID             uuid.UUID  `json:"id"`
	NoteID         uuid.UUID  `json:"note_id"`
	RecipientEmail string     `json:"recipient_email"`
	Permission     string     `json:"permission"`
	ExpiresAt      *time.Time `json:"expires_at,omitempty"`
	RevokedAt      *time.Time `json:"revoked_at,omitempty"`
	LastSentAt     *time.Time `json:"last_sent_at,omitempty"`
	LastOpenedAt   *time.Time `json:"last_opened_at,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

type shareInput struct {
	RecipientEmail string     `json:"recipient_email"`
	Permission     string     `json:"permission"`
	ExpiresAt      *time.Time `json:"expires_at"`
	Language       string     `json:"language"`
}

type shareUpdateInput struct {
	Permission *string    `json:"permission"`
	ExpiresAt  *time.Time `json:"expires_at"`
}

type guestAccess struct {
	SessionID     uuid.UUID
	ShareID       uuid.UUID
	NoteID        uuid.UUID
	OwnerID       uuid.UUID
	Email         string
	Permission    string
	ShareExpires  *time.Time
	SessionExpiry time.Time
}

func NewSharingService(db *pgxpool.Pool, mailer NoteMailer, auditLogger audit.Logger, limiter *ratelimit.Limiter, appURL string, secureCookie bool) *SharingService {
	return &SharingService{db: db, mailer: mailer, audit: auditLogger, limiter: limiter,
		appURL: strings.TrimRight(appURL, "/"), secureCookie: secureCookie}
}

func validPermission(permission string) bool {
	return permission == "view" || permission == "check" || permission == "edit"
}

func normalizeEmail(raw string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(raw))
	parsed, err := mail.ParseAddress(normalized)
	if err != nil || parsed.Address != normalized || len(normalized) > 320 {
		return "", ErrInvalid
	}
	return normalized, nil
}

func secureToken() (string, string, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", "", err
	}
	raw := base64.RawURLEncoding.EncodeToString(random)
	hash := sha256.Sum256([]byte(raw))
	return raw, hex.EncodeToString(hash[:]), nil
}

func tokenHash(raw string) string {
	hash := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(hash[:])
}

func scanShare(row pgx.Row) (NoteShare, error) {
	var share NoteShare
	err := row.Scan(&share.ID, &share.NoteID, &share.RecipientEmail, &share.Permission,
		&share.ExpiresAt, &share.RevokedAt, &share.LastSentAt, &share.LastOpenedAt,
		&share.CreatedAt, &share.UpdatedAt)
	return share, err
}

const shareColumns = `id, note_id, recipient_email, permission, expires_at, revoked_at,
 last_sent_at, last_opened_at, created_at, updated_at`

func (handler *Handler) ListShares(w http.ResponseWriter, request *http.Request) {
	owner := middleware.UserFromContext(request.Context())
	noteID, ok := noteIDParam(w, request)
	if !ok {
		return
	}
	rows, err := handler.sharing.db.Query(request.Context(), `SELECT `+shareColumns+`
		FROM note_shares WHERE note_id = $1 AND created_by = $2 ORDER BY created_at DESC`, noteID, owner.ID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	defer rows.Close()
	shares := make([]NoteShare, 0)
	for rows.Next() {
		share, scanErr := scanShare(rows)
		if scanErr != nil {
			handler.respondError(w, scanErr)
			return
		}
		shares = append(shares, share)
	}
	if err := rows.Err(); err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, shares)
}

func (handler *Handler) CreateShare(w http.ResponseWriter, request *http.Request) {
	owner := middleware.UserFromContext(request.Context())
	noteID, ok := noteIDParam(w, request)
	if !ok {
		return
	}
	var input shareInput
	if !decodeJSON(w, request, &input) {
		return
	}
	email, err := normalizeEmail(input.RecipientEmail)
	if err != nil || !validPermission(input.Permission) || input.ExpiresAt != nil && input.ExpiresAt.Before(time.Now()) {
		handler.respondError(w, ErrInvalid)
		return
	}
	if !handler.allow(w, request, ratelimit.KeyUserNoteInvite, owner.ID.String(), 20, time.Hour) {
		return
	}
	note, err := handler.service.Get(request.Context(), owner.ID, noteID, false)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	if input.Permission == "check" && note.Type != TypeChecklist {
		handler.respondError(w, ErrInvalid)
		return
	}
	rawToken, hash, err := secureToken()
	if err != nil {
		handler.respondError(w, err)
		return
	}
	share, err := scanShare(handler.sharing.db.QueryRow(request.Context(), `INSERT INTO note_shares
		(note_id, created_by, recipient_email, permission, invitation_token_hash, expires_at)
		SELECT $1, $2, $3, $4, $5, $6
		WHERE (SELECT count(*) FROM note_shares WHERE note_id = $1 AND revoked_at IS NULL) < $7
		RETURNING `+shareColumns, noteID, owner.ID, email, input.Permission, hash, input.ExpiresAt, maxNoteShares))
	if errors.Is(err, pgx.ErrNoRows) {
		httputil.RespondError(w, http.StatusConflict, "active invitation limit reached")
		return
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "23505" {
		httputil.RespondError(w, http.StatusConflict, "an active invitation already exists")
		return
	}
	if err != nil {
		handler.respondError(w, err)
		return
	}
	if err := handler.sendInvitation(request.Context(), owner.DisplayName, note.Title, rawToken, input.Language, share); err != nil {
		log.Warn().Err(err).Str("share_id", share.ID.String()).Msg("note invitation email failed")
		httputil.RespondError(w, http.StatusBadGateway, "invitation created but email could not be sent")
		return
	}
	handler.sharing.db.Exec(request.Context(), `UPDATE note_shares SET last_sent_at = NOW(), updated_at = NOW() WHERE id = $1`, share.ID)
	handler.sharing.log(owner.ID, owner.Email, noteID, audit.EventNoteShareCreated, map[string]any{"share_id": share.ID, "permission": share.Permission})
	share.LastSentAt = timePointer(time.Now())
	httputil.Respond(w, http.StatusCreated, share)
}

func (handler *Handler) UpdateShare(w http.ResponseWriter, request *http.Request) {
	owner := middleware.UserFromContext(request.Context())
	noteID, shareID, ok := shareParams(w, request)
	if !ok {
		return
	}
	var input shareUpdateInput
	if !decodeJSON(w, request, &input) {
		return
	}
	if input.Permission != nil && !validPermission(*input.Permission) || input.ExpiresAt != nil && input.ExpiresAt.Before(time.Now()) {
		handler.respondError(w, ErrInvalid)
		return
	}
	if input.Permission != nil && *input.Permission == "check" {
		var noteType string
		if err := handler.sharing.db.QueryRow(request.Context(), `SELECT type FROM notes WHERE id = $1 AND owner_id = $2`, noteID, owner.ID).Scan(&noteType); err != nil || noteType != TypeChecklist {
			handler.respondError(w, ErrInvalid)
			return
		}
	}
	share, err := scanShare(handler.sharing.db.QueryRow(request.Context(), `UPDATE note_shares SET
		permission = COALESCE($4, permission), expires_at = $5, updated_at = NOW()
		WHERE id = $1 AND note_id = $2 AND created_by = $3 AND revoked_at IS NULL
		RETURNING `+shareColumns, shareID, noteID, owner.ID, input.Permission, input.ExpiresAt))
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	if err != nil {
		handler.respondError(w, err)
		return
	}
	handler.sharing.log(owner.ID, owner.Email, noteID, audit.EventNoteShareModified, map[string]any{"share_id": share.ID})
	httputil.Respond(w, http.StatusOK, share)
}

func (handler *Handler) RevokeShare(w http.ResponseWriter, request *http.Request) {
	owner := middleware.UserFromContext(request.Context())
	noteID, shareID, ok := shareParams(w, request)
	if !ok {
		return
	}
	tx, err := handler.sharing.db.Begin(request.Context())
	if err != nil {
		handler.respondError(w, err)
		return
	}
	defer tx.Rollback(request.Context())
	tag, err := tx.Exec(request.Context(), `UPDATE note_shares SET revoked_at = NOW(), updated_at = NOW()
		WHERE id = $1 AND note_id = $2 AND created_by = $3 AND revoked_at IS NULL`, shareID, noteID, owner.ID)
	if err == nil && tag.RowsAffected() > 0 {
		_, err = tx.Exec(request.Context(), `UPDATE note_guest_sessions SET revoked_at = NOW()
			WHERE share_id = $1 AND revoked_at IS NULL`, shareID)
	}
	if err != nil || tag.RowsAffected() == 0 {
		if err == nil {
			err = ErrNotFound
		}
		handler.respondError(w, err)
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		handler.respondError(w, err)
		return
	}
	handler.sharing.log(owner.ID, owner.Email, noteID, audit.EventNoteShareRevoked, map[string]any{"share_id": shareID})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (handler *Handler) ResendShare(w http.ResponseWriter, request *http.Request) {
	owner := middleware.UserFromContext(request.Context())
	noteID, shareID, ok := shareParams(w, request)
	if !ok {
		return
	}
	if !handler.allow(w, request, ratelimit.KeyNoteShareResend, shareID.String(), 10, time.Hour) {
		return
	}
	note, err := handler.service.Get(request.Context(), owner.ID, noteID, false)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	rawToken, hash, err := secureToken()
	if err != nil {
		handler.respondError(w, err)
		return
	}
	share, err := scanShare(handler.sharing.db.QueryRow(request.Context(), `UPDATE note_shares
		SET invitation_token_hash = $4, updated_at = NOW()
		WHERE id = $1 AND note_id = $2 AND created_by = $3 AND revoked_at IS NULL
		  AND (expires_at IS NULL OR expires_at > NOW()) RETURNING `+shareColumns,
		shareID, noteID, owner.ID, hash))
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrNotFound
	}
	if err != nil {
		handler.respondError(w, err)
		return
	}
	if err := handler.sendInvitation(request.Context(), owner.DisplayName, note.Title, rawToken, "", share); err != nil {
		log.Warn().Err(err).Str("share_id", share.ID.String()).Msg("note invitation resend failed")
		httputil.RespondError(w, http.StatusBadGateway, "invitation email could not be sent")
		return
	}
	handler.sharing.db.Exec(request.Context(), `UPDATE note_shares SET last_sent_at = NOW(), updated_at = NOW() WHERE id = $1`, share.ID)
	handler.sharing.log(owner.ID, owner.Email, noteID, audit.EventNoteShareModified, map[string]any{"share_id": share.ID, "action": "resent"})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (handler *Handler) sendInvitation(ctx context.Context, ownerName, noteTitle, rawToken, language string, share NoteShare) error {
	if handler.sharing.mailer == nil {
		return errors.New("SMTP is not configured")
	}
	if language != "da" {
		language = "en"
	}
	inviteLink := handler.sharing.appURL + "/notes/invite/" + url.PathEscape(rawToken)
	return handler.sharing.mailer.SendNoteInvitation(ctx, share.RecipientEmail, ownerName, noteTitle,
		share.Permission, inviteLink, language, share.ExpiresAt)
}

func (handler *Handler) AcceptInvitation(w http.ResponseWriter, request *http.Request) {
	noStore(w)
	w.Header().Set("Referrer-Policy", "no-referrer")
	rawToken := chi.URLParam(request, "token")
	if !handler.allow(w, request, ratelimit.KeyIPNoteInviteAccept, middleware.ClientIP(request), 20, 15*time.Minute) {
		return
	}
	var shareID, noteID uuid.UUID
	var recipientEmail string
	var expiresAt *time.Time
	err := handler.sharing.db.QueryRow(request.Context(), `SELECT ns.id, ns.note_id, ns.expires_at, ns.recipient_email
		FROM note_shares ns JOIN notes n ON n.id = ns.note_id JOIN users u ON u.id = n.owner_id
		WHERE ns.invitation_token_hash = $1 AND ns.revoked_at IS NULL
		  AND (ns.expires_at IS NULL OR ns.expires_at > NOW())
		  AND n.deleted_at IS NULL AND u.is_active = TRUE`, tokenHash(rawToken)).Scan(&shareID, &noteID, &expiresAt, &recipientEmail)
	if err != nil {
		http.Redirect(w, request, "/guest/notes/unavailable", http.StatusSeeOther)
		return
	}
	sessionToken, sessionHash, err := secureToken()
	if err != nil {
		http.Redirect(w, request, "/guest/notes/unavailable", http.StatusSeeOther)
		return
	}
	sessionExpiry := time.Now().Add(guestSessionTTL)
	if expiresAt != nil && expiresAt.Before(sessionExpiry) {
		sessionExpiry = *expiresAt
	}
	_, err = handler.sharing.db.Exec(request.Context(), `INSERT INTO note_guest_sessions
		(share_id, session_token_hash, expires_at) VALUES ($1, $2, $3)`, shareID, sessionHash, sessionExpiry)
	if err != nil {
		http.Redirect(w, request, "/guest/notes/unavailable", http.StatusSeeOther)
		return
	}
	handler.sharing.db.Exec(request.Context(), `UPDATE note_shares SET last_opened_at = NOW(), updated_at = NOW() WHERE id = $1`, shareID)
	handler.sharing.log(uuid.Nil, recipientEmail, noteID, audit.EventNoteGuestSessionCreated, map[string]any{"share_id": shareID})
	http.SetCookie(w, &http.Cookie{Name: guestCookieName, Value: sessionToken, Path: "/api/v1/guest",
		HttpOnly: true, Secure: handler.sharing.secureCookie, SameSite: http.SameSiteLaxMode,
		Expires: sessionExpiry, MaxAge: int(time.Until(sessionExpiry).Seconds())})
	http.Redirect(w, request, "/guest/notes/"+noteID.String(), http.StatusSeeOther)
}

func (handler *Handler) GuestGet(w http.ResponseWriter, request *http.Request) {
	noStore(w)
	access, ok := handler.guestAccess(w, request)
	if !ok {
		return
	}
	note, err := handler.service.Get(request.Context(), access.OwnerID, access.NoteID, false)
	if err != nil {
		guestUnavailable(w)
		return
	}
	handler.sharing.log(uuid.Nil, access.Email, note.ID, audit.EventNoteGuestAccessed, map[string]any{"share_id": access.ShareID})
	httputil.Respond(w, http.StatusOK, map[string]any{"note": note, "recipient_email": access.Email,
		"permission": access.Permission, "expires_at": access.ShareExpires})
}

func (handler *Handler) GuestUpdate(w http.ResponseWriter, request *http.Request) {
	noStore(w)
	if !handler.validOrigin(request) {
		httputil.RespondError(w, http.StatusForbidden, "request origin is not allowed")
		return
	}
	access, ok := handler.guestAccess(w, request)
	if !ok {
		return
	}
	if access.Permission != "edit" {
		httputil.RespondError(w, http.StatusForbidden, "permission denied")
		return
	}
	var input UpdateInput
	if !decodeJSON(w, request, &input) {
		return
	}
	input.IsPinned = nil
	input.IsArchived = nil
	note, err := handler.service.Update(request.Context(), access.OwnerID, access.NoteID, input)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	handler.logGuestUpdate(access)
	httputil.Respond(w, http.StatusOK, note)
}

func (handler *Handler) GuestCreateItem(w http.ResponseWriter, request *http.Request) {
	handler.guestItemMutation(w, request, true, func(access guestAccess, input ItemInput, _ uuid.UUID) (Note, error) {
		return handler.service.CreateItem(request.Context(), access.OwnerID, access.NoteID, input)
	})
}

func (handler *Handler) GuestUpdateItem(w http.ResponseWriter, request *http.Request) {
	handler.guestItemMutation(w, request, false, func(access guestAccess, input ItemInput, itemID uuid.UUID) (Note, error) {
		if access.Permission == "check" && (input.Content != nil || input.IsChecked == nil || input.Position != nil) {
			return Note{}, errors.New("permission denied")
		}
		return handler.service.UpdateItem(request.Context(), access.OwnerID, access.NoteID, itemID, input)
	})
}

func (handler *Handler) GuestDeleteItem(w http.ResponseWriter, request *http.Request) {
	noStore(w)
	if !handler.validOrigin(request) {
		httputil.RespondError(w, http.StatusForbidden, "request origin is not allowed")
		return
	}
	access, ok := handler.guestAccess(w, request)
	if !ok {
		return
	}
	if access.Permission != "edit" {
		httputil.RespondError(w, http.StatusForbidden, "permission denied")
		return
	}
	itemID, err := uuid.Parse(chi.URLParam(request, "itemId"))
	if err != nil {
		handler.respondError(w, ErrInvalid)
		return
	}
	note, err := handler.service.DeleteItem(request.Context(), access.OwnerID, access.NoteID, itemID, int64(queryInt(request, "version", 0)))
	if err != nil {
		handler.respondError(w, err)
		return
	}
	handler.logGuestUpdate(access)
	httputil.Respond(w, http.StatusOK, note)
}

func (handler *Handler) GuestReorderItems(w http.ResponseWriter, request *http.Request) {
	noStore(w)
	if !handler.validOrigin(request) {
		httputil.RespondError(w, http.StatusForbidden, "request origin is not allowed")
		return
	}
	access, ok := handler.guestAccess(w, request)
	if !ok {
		return
	}
	if access.Permission != "edit" {
		httputil.RespondError(w, http.StatusForbidden, "permission denied")
		return
	}
	var input ReorderInput
	if !decodeJSON(w, request, &input) {
		return
	}
	note, err := handler.service.ReorderItems(request.Context(), access.OwnerID, access.NoteID, input)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	handler.logGuestUpdate(access)
	httputil.Respond(w, http.StatusOK, note)
}

func (handler *Handler) guestItemMutation(w http.ResponseWriter, request *http.Request, editOnly bool, mutation func(guestAccess, ItemInput, uuid.UUID) (Note, error)) {
	noStore(w)
	if !handler.validOrigin(request) {
		httputil.RespondError(w, http.StatusForbidden, "request origin is not allowed")
		return
	}
	access, ok := handler.guestAccess(w, request)
	if !ok {
		return
	}
	if editOnly && access.Permission != "edit" || !editOnly && access.Permission != "edit" && access.Permission != "check" {
		httputil.RespondError(w, http.StatusForbidden, "permission denied")
		return
	}
	var input ItemInput
	if !decodeJSON(w, request, &input) {
		return
	}
	itemID := uuid.Nil
	if rawID := chi.URLParam(request, "itemId"); rawID != "" {
		var err error
		itemID, err = uuid.Parse(rawID)
		if err != nil {
			handler.respondError(w, ErrInvalid)
			return
		}
	}
	note, err := mutation(access, input, itemID)
	if err != nil {
		if err.Error() == "permission denied" {
			httputil.RespondError(w, http.StatusForbidden, "permission denied")
		} else {
			handler.respondError(w, err)
		}
		return
	}
	handler.logGuestUpdate(access)
	httputil.Respond(w, http.StatusOK, note)
}

func (handler *Handler) GuestLogout(w http.ResponseWriter, request *http.Request) {
	noStore(w)
	if !handler.validOrigin(request) {
		httputil.RespondError(w, http.StatusForbidden, "request origin is not allowed")
		return
	}
	if cookie, err := request.Cookie(guestCookieName); err == nil {
		handler.sharing.db.Exec(request.Context(), `UPDATE note_guest_sessions SET revoked_at = NOW()
			WHERE session_token_hash = $1 AND revoked_at IS NULL`, tokenHash(cookie.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: guestCookieName, Value: "", Path: "/api/v1/guest", HttpOnly: true,
		Secure: handler.sharing.secureCookie, SameSite: http.SameSiteLaxMode, MaxAge: -1, Expires: time.Unix(1, 0)})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (handler *Handler) guestAccess(w http.ResponseWriter, request *http.Request) (guestAccess, bool) {
	cookie, err := request.Cookie(guestCookieName)
	if err != nil {
		guestUnavailable(w)
		return guestAccess{}, false
	}
	noteID, err := uuid.Parse(chi.URLParam(request, "id"))
	if err != nil {
		guestUnavailable(w)
		return guestAccess{}, false
	}
	if request.Method != http.MethodGet && !handler.allow(w, request, ratelimit.KeyGuestNoteMutation, access.SessionID.String(), 120, time.Minute) {
		return guestAccess{}, false
	}
	var access guestAccess
	err = handler.sharing.db.QueryRow(request.Context(), `SELECT ngs.id, ns.id, ns.note_id, n.owner_id,
		ns.recipient_email, ns.permission, ns.expires_at, ngs.expires_at
		FROM note_guest_sessions ngs
		JOIN note_shares ns ON ns.id = ngs.share_id
		JOIN notes n ON n.id = ns.note_id
		JOIN users u ON u.id = n.owner_id
		WHERE ngs.session_token_hash = $1 AND ns.note_id = $2
		  AND ngs.revoked_at IS NULL AND ngs.expires_at > NOW()
		  AND ns.revoked_at IS NULL AND (ns.expires_at IS NULL OR ns.expires_at > NOW())
		  AND n.deleted_at IS NULL AND u.is_active = TRUE`, tokenHash(cookie.Value), noteID).Scan(
		&access.SessionID, &access.ShareID, &access.NoteID, &access.OwnerID, &access.Email,
		&access.Permission, &access.ShareExpires, &access.SessionExpiry)
	if err != nil {
		guestUnavailable(w)
		return guestAccess{}, false
	}
	handler.sharing.db.Exec(request.Context(), `UPDATE note_guest_sessions SET last_accessed_at = NOW()
		WHERE id = $1 AND (last_accessed_at IS NULL OR last_accessed_at < NOW() - INTERVAL '5 minutes')`, access.SessionID)
	return access, true
}

func (handler *Handler) validOrigin(request *http.Request) bool {
	allowed, err := url.Parse(handler.sharing.appURL)
	if err != nil {
		return false
	}
	for _, raw := range []string{request.Header.Get("Origin"), request.Header.Get("Referer")} {
		if raw == "" {
			continue
		}
		candidate, parseErr := url.Parse(raw)
		return parseErr == nil && strings.EqualFold(candidate.Scheme, allowed.Scheme) && strings.EqualFold(candidate.Host, allowed.Host)
	}
	return false
}

func (handler *Handler) allow(w http.ResponseWriter, request *http.Request, key, identity string, limit int, window time.Duration) bool {
	if handler.sharing.limiter == nil {
		return true
	}
	allowed, _, _, err := handler.sharing.limiter.Allow(request.Context(), key, identity, limit, window)
	if err != nil {
		log.Warn().Err(err).Msg("notes rate limiter unavailable")
		return true
	}
	if !allowed {
		httputil.RespondError(w, http.StatusTooManyRequests, "too many requests")
	}
	return allowed
}

func (handler *Handler) logGuestUpdate(access guestAccess) {
	handler.sharing.log(uuid.Nil, access.Email, access.NoteID, audit.EventNoteGuestUpdated, map[string]any{"share_id": access.ShareID})
}

func (service *SharingService) log(actorID uuid.UUID, actorEmail string, noteID uuid.UUID, eventType string, metadata map[string]any) {
	if service.audit == nil {
		return
	}
	var actor *uuid.UUID
	if actorID != uuid.Nil {
		actor = &actorID
	}
	service.audit.Log(context.Background(), audit.Event{Type: eventType, ActorID: actor, ActorEmail: actorEmail,
		ResourceType: "note", ResourceID: &noteID, Metadata: metadata})
}

func shareParams(w http.ResponseWriter, request *http.Request) (uuid.UUID, uuid.UUID, bool) {
	noteID, ok := noteIDParam(w, request)
	if !ok {
		return uuid.Nil, uuid.Nil, false
	}
	shareID, err := uuid.Parse(chi.URLParam(request, "shareId"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid share id")
		return uuid.Nil, uuid.Nil, false
	}
	return noteID, shareID, true
}

func noStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func guestUnavailable(w http.ResponseWriter) {
	noStore(w)
	httputil.RespondError(w, http.StatusUnauthorized, "This invitation link is invalid or no longer active.")
}

func timePointer(value time.Time) *time.Time {
	return &value
}
