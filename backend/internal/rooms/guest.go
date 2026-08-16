package rooms

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
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog/log"

	"github.com/yourname/privatedrive/internal/audit"
	"github.com/yourname/privatedrive/internal/httputil"
	"github.com/yourname/privatedrive/internal/middleware"
	"github.com/yourname/privatedrive/internal/ratelimit"
)

const (
	roomGuestCookieName = "room_guest_session"
	roomGuestSessionTTL = 24 * time.Hour
	maxRoomInvites      = 100
)

type RoomInvite struct {
	ID             uuid.UUID  `json:"id"`
	RoomID         uuid.UUID  `json:"room_id"`
	Label          string     `json:"label"`
	CanChat        bool       `json:"can_chat"`
	CanUpload      bool       `json:"can_upload"`
	CanVoice       bool       `json:"can_voice"`
	CanShareScreen bool       `json:"can_share_screen"`
	ExpiresAt      time.Time  `json:"expires_at"`
	RevokedAt      *time.Time `json:"revoked_at,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
}

type createRoomInviteRequest struct {
	Email          string `json:"email"`
	Label          string `json:"label"`
	ExpiresHours   int    `json:"expires_hours"`
	CanChat        bool   `json:"can_chat"`
	CanUpload      bool   `json:"can_upload"`
	CanVoice       bool   `json:"can_voice"`
	CanShareScreen bool   `json:"can_share_screen"`
}

type acceptRoomInviteRequest struct {
	DisplayName string `json:"display_name"`
}

type roomGuestAccess struct {
	SessionID      uuid.UUID
	InviteID       uuid.UUID
	RoomID         uuid.UUID
	RoomName       string
	RoomSlug       string
	OwnerID        uuid.UUID
	DisplayName    string
	CanChat        bool
	CanUpload      bool
	CanVoice       bool
	CanShareScreen bool
	ExpiresAt      time.Time
}

func secureRoomToken() (string, string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	return token, hashRoomToken(token), nil
}

func hashRoomToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func scanRoomInvite(row pgx.Row) (RoomInvite, error) {
	var invite RoomInvite
	err := row.Scan(&invite.ID, &invite.RoomID, &invite.Label, &invite.CanChat, &invite.CanUpload,
		&invite.CanVoice, &invite.CanShareScreen, &invite.ExpiresAt, &invite.RevokedAt, &invite.CreatedAt)
	return invite, err
}

const roomInviteColumns = `id, room_id, label, can_chat, can_upload, can_voice,
	can_share_screen, expires_at, revoked_at, created_at`

var (
	errInvalidGuestEmail = errors.New("invalid guest email")
	errInvalidRoomInvite = errors.New("invalid room invitation")
)

func normalizeRoomInviteInput(input *createRoomInviteRequest) error {
	input.Email = strings.TrimSpace(input.Email)
	input.Label = strings.TrimSpace(input.Label)
	if input.Email != "" {
		address, err := mail.ParseAddress(input.Email)
		if err != nil || !strings.EqualFold(address.Address, input.Email) {
			return errInvalidGuestEmail
		}
		input.Email = address.Address
		if input.Label == "" {
			input.Label = input.Email
		}
	}
	if utf8.RuneCountInString(input.Label) > 120 || input.ExpiresHours < 1 || input.ExpiresHours > 24*30 {
		return errInvalidRoomInvite
	}
	return nil
}

func (handler *Handler) insertRoomInvite(ctx context.Context, roomID, actorID uuid.UUID, input createRoomInviteRequest) (RoomInvite, string, error) {
	rawToken, tokenHash, err := secureRoomToken()
	if err != nil {
		return RoomInvite{}, "", err
	}
	expiresAt := time.Now().Add(time.Duration(input.ExpiresHours) * time.Hour)
	invite, err := scanRoomInvite(handler.service.db.QueryRow(ctx, `INSERT INTO room_invites
		(room_id, token_hash, label, created_by, can_chat, can_upload, can_voice, can_share_screen, expires_at)
		SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
		WHERE (SELECT count(*) FROM room_invites WHERE room_id=$1 AND revoked_at IS NULL AND expires_at > now()) < $10
		RETURNING `+roomInviteColumns, roomID, tokenHash, input.Label, actorID, input.CanChat, input.CanUpload,
		input.CanVoice, input.CanShareScreen, expiresAt, maxRoomInvites))
	return invite, rawToken, err
}

func (handler *Handler) sendGuestInvitation(ctx context.Context, email, displayName, fallbackName string, room Room, inviteURL string) bool {
	if email == "" || handler.mailer == nil {
		return false
	}
	inviterName := strings.TrimSpace(displayName)
	if inviterName == "" {
		inviterName = fallbackName
	}
	if err := handler.mailer.SendRoomInvitation(ctx, email, inviterName, room.Name, "guest", inviteURL); err != nil {
		log.Warn().Err(err).Str("room_id", room.ID.String()).Msg("rooms: guest invitation email failed")
		return false
	}
	return true
}

func (handler *Handler) CreateInvite(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return
	}
	var input createRoomInviteRequest
	if !decodeRequest(w, request, &input) {
		return
	}
	if err := normalizeRoomInviteInput(&input); err != nil {
		message := "invalid room invitation"
		if errors.Is(err, errInvalidGuestEmail) {
			message = err.Error()
		}
		httputil.RespondError(w, http.StatusBadRequest, message)
		return
	}
	actor := middleware.UserFromContext(request.Context())
	room, err := handler.service.Get(request.Context(), actor.ID, roomID)
	if err != nil || room.ArchivedAt != nil || room.CurrentRole != RoleOwner && room.CurrentRole != RoleModerator {
		handler.respondError(w, ErrForbidden)
		return
	}
	if !handler.allowRoomAction(request.Context(), ratelimit.KeyUserRoomInvite, actor.ID.String(), 20, time.Hour) {
		httputil.RespondError(w, http.StatusTooManyRequests, "room invitation rate limit exceeded")
		return
	}
	invite, rawToken, err := handler.insertRoomInvite(request.Context(), roomID, actor.ID, input)
	if errors.Is(err, pgx.ErrNoRows) {
		httputil.RespondError(w, http.StatusConflict, "active room invitation limit reached")
		return
	}
	if err != nil {
		handler.respondError(w, err)
		return
	}
	handler.service.log(request.Context(), audit.EventRoomInviteCreated, actor.ID, room, nil, map[string]any{"invite_id": invite.ID})
	inviteURL := strings.TrimRight(handler.appURL, "/") + "/rooms/invite/" + url.PathEscape(rawToken)
	mailSent := handler.sendGuestInvitation(request.Context(), input.Email, actor.DisplayName, actor.Email, room, inviteURL)
	httputil.Respond(w, http.StatusCreated, map[string]any{"invite": invite, "invite_url": inviteURL, "mail_sent": mailSent})
}
func (handler *Handler) ListInvites(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return
	}
	actor := middleware.UserFromContext(request.Context())
	room, err := handler.service.Get(request.Context(), actor.ID, roomID)
	if err != nil || room.CurrentRole != RoleOwner && room.CurrentRole != RoleModerator {
		handler.respondError(w, ErrForbidden)
		return
	}
	rows, err := handler.service.db.Query(request.Context(), `SELECT `+roomInviteColumns+`
		FROM room_invites WHERE room_id=$1 AND revoked_at IS NULL AND expires_at > now()
		ORDER BY created_at DESC LIMIT 100`, roomID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	defer rows.Close()
	invites := make([]RoomInvite, 0)
	for rows.Next() {
		invite, scanErr := scanRoomInvite(rows)
		if scanErr != nil {
			handler.respondError(w, scanErr)
			return
		}
		invites = append(invites, invite)
	}
	httputil.Respond(w, http.StatusOK, invites)
}

func (handler *Handler) RevokeInvite(w http.ResponseWriter, request *http.Request) {
	roomID, ok := roomIDParam(w, request)
	if !ok {
		return
	}
	inviteID, err := uuid.Parse(chi.URLParam(request, "inviteID"))
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid invitation id")
		return
	}
	actor := middleware.UserFromContext(request.Context())
	room, err := handler.service.Get(request.Context(), actor.ID, roomID)
	if err != nil || room.CurrentRole != RoleOwner && room.CurrentRole != RoleModerator {
		handler.respondError(w, ErrForbidden)
		return
	}
	tx, err := handler.service.db.Begin(request.Context())
	if err != nil {
		handler.respondError(w, err)
		return
	}
	defer tx.Rollback(request.Context())
	tag, err := tx.Exec(request.Context(), `UPDATE room_invites SET revoked_at=now()
		WHERE id=$1 AND room_id=$2 AND revoked_at IS NULL`, inviteID, roomID)
	if err != nil || tag.RowsAffected() == 0 {
		handler.respondError(w, ErrNotFound)
		return
	}
	if _, err := tx.Exec(request.Context(), `UPDATE room_guest_sessions SET revoked_at=now()
		WHERE invite_id=$1 AND revoked_at IS NULL`, inviteID); err != nil {
		handler.respondError(w, err)
		return
	}
	if err := tx.Commit(request.Context()); err != nil {
		handler.respondError(w, err)
		return
	}
	handler.service.log(request.Context(), audit.EventRoomInviteRevoked, actor.ID, room, nil, map[string]any{"invite_id": inviteID})
	handler.publishRoomEvent(request.Context(), roomID, roomEvent{Type: "guest_session_revoked", InviteID: inviteID.String()})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (handler *Handler) AcceptInvite(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if !handler.validGuestOrigin(request) {
		httputil.RespondError(w, http.StatusForbidden, "request origin is not allowed")
		return
	}
	if !handler.allowRoomAction(request.Context(), ratelimit.KeyIPRoomInviteAccept, middleware.ClientIP(request), 20, 15*time.Minute) {
		httputil.RespondError(w, http.StatusTooManyRequests, "room invitation rate limit exceeded")
		return
	}
	var input acceptRoomInviteRequest
	if !decodeRequest(w, request, &input) {
		return
	}
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if input.DisplayName == "" || utf8.RuneCountInString(input.DisplayName) > 80 {
		httputil.RespondError(w, http.StatusBadRequest, "invalid guest display name")
		return
	}
	var inviteID, roomID, ownerID uuid.UUID
	var roomName string
	var inviteExpiry time.Time
	err := handler.service.db.QueryRow(request.Context(), `SELECT ri.id, ri.room_id, ri.expires_at, r.owner_id, r.name
		FROM room_invites ri JOIN rooms r ON r.id=ri.room_id JOIN users owner ON owner.id=r.owner_id
		WHERE ri.token_hash=$1 AND ri.revoked_at IS NULL AND ri.expires_at>now()
		AND r.archived_at IS NULL AND owner.is_active=TRUE`, hashRoomToken(chi.URLParam(request, "token"))).Scan(&inviteID, &roomID, &inviteExpiry, &ownerID, &roomName)
	if err != nil {
		httputil.RespondError(w, http.StatusNotFound, "room invitation is invalid or expired")
		return
	}
	sessionToken, sessionHash, err := secureRoomToken()
	if err != nil {
		handler.respondError(w, err)
		return
	}
	sessionExpiry := time.Now().Add(roomGuestSessionTTL)
	if inviteExpiry.Before(sessionExpiry) {
		sessionExpiry = inviteExpiry
	}
	var sessionID uuid.UUID
	err = handler.service.db.QueryRow(request.Context(), `INSERT INTO room_guest_sessions
		(invite_id, session_token_hash, display_name, expires_at) VALUES($1,$2,$3,$4) RETURNING id`,
		inviteID, sessionHash, input.DisplayName, sessionExpiry).Scan(&sessionID)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	handler.service.log(request.Context(), audit.EventRoomGuestJoined, ownerID, Room{ID: roomID, Name: roomName}, nil,
		map[string]any{"guest_session_id": sessionID, "invite_id": inviteID})
	http.SetCookie(w, &http.Cookie{Name: roomGuestCookieName, Value: sessionToken, Path: "/api/v1/guest",
		HttpOnly: true, Secure: handler.secureCookie, SameSite: http.SameSiteLaxMode,
		Expires: sessionExpiry, MaxAge: int(time.Until(sessionExpiry).Seconds())})
	httputil.Respond(w, http.StatusCreated, map[string]any{"room_id": roomID, "session_id": sessionID})
}

func (handler *Handler) GuestGet(w http.ResponseWriter, request *http.Request) {
	access, ok := handler.guestAccess(w, request)
	if !ok {
		return
	}
	limits, err := handler.guestUploadLimits(request.Context())
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, map[string]any{
		"id": access.RoomID, "name": access.RoomName, "guest_session_id": access.SessionID,
		"display_name": access.DisplayName, "can_chat": access.CanChat, "can_upload": access.CanUpload && limits.Enabled,
		"upload_max_file_bytes": limits.MaxFileBytes, "upload_max_files_session": limits.MaxFilesSession,
		"can_voice": access.CanVoice, "can_share_screen": access.CanShareScreen, "expires_at": access.ExpiresAt,
	})
}

func (handler *Handler) GuestListMessages(w http.ResponseWriter, request *http.Request) {
	access, ok := handler.guestAccess(w, request)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	limit = normalizeMessagePageLimit(limit)
	var cursor *uuid.UUID
	if raw := request.URL.Query().Get("cursor"); raw != "" {
		parsed, err := uuid.Parse(raw)
		if err != nil {
			httputil.RespondError(w, http.StatusBadRequest, "invalid message cursor")
			return
		}
		cursor = &parsed
	}
	messages, err := handler.service.queryMessagePage(request.Context(), access.RoomID, limit+1, cursor)
	if err == nil {
		err = handler.service.loadMessageReactions(request.Context(), messages)
	}
	if err != nil {
		handler.respondError(w, err)
		return
	}
	httputil.Respond(w, http.StatusOK, buildMessagePage(messages, limit))
}

func (handler *Handler) GuestCreateMessage(w http.ResponseWriter, request *http.Request) {
	if !handler.validGuestOrigin(request) {
		httputil.RespondError(w, http.StatusForbidden, "request origin is not allowed")
		return
	}
	access, ok := handler.guestAccess(w, request)
	if !ok {
		return
	}
	if !access.CanChat {
		httputil.RespondError(w, http.StatusForbidden, "guest chat is not allowed")
		return
	}
	if !handler.allowRoomAction(request.Context(), ratelimit.KeyGuestRoomMutation, access.SessionID.String(), 60, time.Minute) {
		httputil.RespondError(w, http.StatusTooManyRequests, "guest room rate limit exceeded")
		return
	}
	var input createMessageRequest
	if !decodeRequest(w, request, &input) {
		return
	}
	message, err := handler.service.createGuestMessage(request.Context(), access, input.Body, input.ReplyTo)
	if err != nil {
		handler.respondError(w, err)
		return
	}
	handler.publish(request.Context(), access.RoomID)
	httputil.Respond(w, http.StatusCreated, message)
}

func (service *Service) createGuestMessage(ctx context.Context, access roomGuestAccess, body string, replyTo *uuid.UUID) (Message, error) {
	body, err := NormalizeMessage(body, service.ChatMaxLength(ctx))
	if err != nil {
		return Message{}, err
	}
	if service.cryptor == nil {
		return Message{}, ErrEncryptionUnavailable
	}
	if err := validateReply(ctx, service, access.RoomID, replyTo); err != nil {
		return Message{}, err
	}
	plainBody := body
	body, err = service.cryptor.encrypt(body)
	if err != nil {
		return Message{}, err
	}
	var message Message
	err = service.db.QueryRow(ctx, `INSERT INTO room_messages
		(room_id, sender_guest_session_id, body, reply_to_message_id) VALUES($1,$2,$3,$4)
		RETURNING id, room_id, sender_user_id, sender_guest_session_id, body, reply_to_message_id, created_at, edited_at, deleted_at`,
		access.RoomID, access.SessionID, body, replyTo).Scan(&message.ID, &message.RoomID, &message.SenderUserID,
		&message.SenderGuestSessionID, &message.Body, &message.ReplyToMessageID, &message.CreatedAt, &message.EditedAt, &message.DeletedAt)
	message.Body, message.SenderName = plainBody, access.DisplayName
	return message, err
}

func validateReply(ctx context.Context, service *Service, roomID uuid.UUID, replyTo *uuid.UUID) error {
	if replyTo == nil {
		return nil
	}
	var exists bool
	if err := service.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM room_messages
		WHERE id=$1 AND room_id=$2 AND deleted_at IS NULL)`, *replyTo, roomID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

func (handler *Handler) GuestLogout(w http.ResponseWriter, request *http.Request) {
	if cookie, err := request.Cookie(roomGuestCookieName); err == nil {
		_, _ = handler.service.db.Exec(request.Context(), `UPDATE room_guest_sessions SET revoked_at=now()
			WHERE session_token_hash=$1 AND revoked_at IS NULL`, hashRoomToken(cookie.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: roomGuestCookieName, Value: "", Path: "/api/v1/guest",
		HttpOnly: true, Secure: handler.secureCookie, SameSite: http.SameSiteLaxMode,
		MaxAge: -1, Expires: time.Unix(1, 0)})
	httputil.Respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (handler *Handler) guestAccess(w http.ResponseWriter, request *http.Request) (roomGuestAccess, bool) {
	cookie, err := request.Cookie(roomGuestCookieName)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, "guest session is unavailable")
		return roomGuestAccess{}, false
	}
	roomID, err := uuid.Parse(chi.URLParam(request, "roomID"))
	if err != nil {
		httputil.RespondError(w, http.StatusNotFound, "room not found")
		return roomGuestAccess{}, false
	}
	var access roomGuestAccess
	err = handler.service.db.QueryRow(request.Context(), `SELECT rgs.id, ri.id, r.id, r.name, r.slug, r.owner_id, rgs.display_name,
		ri.can_chat, ri.can_upload, ri.can_voice, ri.can_share_screen, rgs.expires_at
		FROM room_guest_sessions rgs JOIN room_invites ri ON ri.id=rgs.invite_id
		JOIN rooms r ON r.id=ri.room_id JOIN users owner ON owner.id=r.owner_id
		WHERE rgs.session_token_hash=$1 AND r.id=$2 AND rgs.revoked_at IS NULL AND rgs.expires_at>now()
		AND ri.revoked_at IS NULL AND ri.expires_at>now() AND r.archived_at IS NULL AND owner.is_active=TRUE`,
		hashRoomToken(cookie.Value), roomID).Scan(&access.SessionID, &access.InviteID, &access.RoomID, &access.RoomName, &access.RoomSlug, &access.OwnerID,
		&access.DisplayName, &access.CanChat, &access.CanUpload, &access.CanVoice, &access.CanShareScreen, &access.ExpiresAt)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, "guest session is unavailable")
		return roomGuestAccess{}, false
	}
	_, _ = handler.service.db.Exec(request.Context(), `UPDATE room_guest_sessions SET last_accessed_at=now()
		WHERE id=$1 AND (last_accessed_at IS NULL OR last_accessed_at<now()-interval '5 minutes')`, access.SessionID)
	return access, true
}

func (handler *Handler) allowRoomAction(ctx context.Context, key, identity string, limit int, window time.Duration) bool {
	if handler.limiter == nil {
		return true
	}
	allowed, _, _, err := handler.limiter.Allow(ctx, key, identity, limit, window)
	return err == nil && allowed
}

func (handler *Handler) validGuestOrigin(request *http.Request) bool {
	configured, err := url.Parse(handler.appURL)
	if err != nil || configured.Host == "" {
		return false
	}
	origin := request.Header.Get("Origin")
	parsed, err := url.Parse(origin)
	return err == nil && parsed.Scheme == configured.Scheme && parsed.Host == configured.Host
}
