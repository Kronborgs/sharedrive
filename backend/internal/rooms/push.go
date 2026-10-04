package rooms

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
)

type pushService struct {
	db        *pgxpool.Pool
	publicKey string
	privateKey string
	subject   string
	encryptionKey []byte
}

type pushSubscriptionPayload struct {
	Endpoint string `json:"endpoint"`
	Keys struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

type storedPushSubscription struct {
	Subscription pushSubscriptionPayload `json:"subscription"`
	Locale       string                  `json:"locale"`
}

type chatPushMessage struct {
    ID     string `json:"id"`
	Path string `json:"path"`
    Locale string `json:"locale"`
}

func newPushService(db *pgxpool.Pool, publicKey, privateKey, subject, sessionSecret string) *pushService {
	publicKey = strings.TrimSpace(publicKey)
	privateKey = strings.TrimSpace(privateKey)
	subject = strings.TrimSpace(subject)
	if db == nil || publicKey == "" || privateKey == "" || subject == "" || sessionSecret == "" {
		return nil
	}
	mac := hmac.New(sha256.New, []byte(sessionSecret))
	_, _ = mac.Write([]byte("sharedrive:web-push-subscriptions:v1"))
	return &pushService{db: db, publicKey: publicKey, privateKey: privateKey, subject: subject, encryptionKey: mac.Sum(nil)}
}

func (service *pushService) isEnabled() bool { return service != nil }

func (service *pushService) encryptSubscription(hash []byte, value storedPushSubscription) ([]byte, error) {
	plain, err := json.Marshal(value)
	if err != nil { return nil, err }
	block, err := aes.NewCipher(service.encryptionKey)
	if err != nil { return nil, err }
	gcm, err := cipher.NewGCM(block)
	if err != nil { return nil, err }
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil { return nil, err }
	return gcm.Seal(nonce, nonce, plain, hash), nil
}

func (service *pushService) decryptSubscription(hash, ciphertext []byte) (storedPushSubscription, error) {
	var value storedPushSubscription
	block, err := aes.NewCipher(service.encryptionKey)
	if err != nil { return value, err }
	gcm, err := cipher.NewGCM(block)
	if err != nil { return value, err }
	if len(ciphertext) < gcm.NonceSize() { return value, errors.New("push subscription ciphertext is too short") }
	plain, err := gcm.Open(nil, ciphertext[:gcm.NonceSize()], ciphertext[gcm.NonceSize():], hash)
	if err != nil { return value, err }
	err = json.Unmarshal(plain, &value)
	return value, err
}

func pushEndpointHash(endpoint string) []byte {
	hash := sha256.Sum256([]byte(endpoint))
	return hash[:]
}

func validatePushSubscription(value pushSubscriptionPayload) error {
	endpoint, err := url.Parse(strings.TrimSpace(value.Endpoint))
	if err != nil || endpoint.Scheme != "https" || endpoint.User != nil || endpoint.Port() != "" || endpoint.Hostname() == "" {
		return errors.New("invalid push endpoint")
	}
	host := strings.ToLower(strings.TrimSuffix(endpoint.Hostname(), "."))
	allowed := strings.HasSuffix(host, ".googleapis.com") || strings.HasSuffix(host, ".push.services.mozilla.com") || strings.HasSuffix(host, ".push.apple.com")
	if !allowed { return errors.New("unsupported push service endpoint") }
	p256dh, err := base64.RawURLEncoding.DecodeString(value.Keys.P256dh)
	if err != nil || len(p256dh) != 65 { return errors.New("invalid push encryption key") }
	auth, err := base64.RawURLEncoding.DecodeString(value.Keys.Auth)
	if err != nil || len(auth) < 16 { return errors.New("invalid push authentication key") }
	return nil
}

func (service *pushService) saveSubscription(ctx context.Context, userID uuid.UUID, value pushSubscriptionPayload, locale string) error {
	if err := validatePushSubscription(value); err != nil { return err }
	if locale != "da" && locale != "en" { locale = "en" }
	hash := pushEndpointHash(value.Endpoint)
	ciphertext, err := service.encryptSubscription(hash, storedPushSubscription{Subscription: value, Locale: locale})
	if err != nil { return err }
	_, err = service.db.Exec(ctx, `INSERT INTO room_push_subscriptions(user_id,endpoint_hash,subscription_ciphertext,created_at,updated_at)
		VALUES($1,$2,$3,now(),now())
		ON CONFLICT(endpoint_hash) DO UPDATE SET user_id=EXCLUDED.user_id,subscription_ciphertext=EXCLUDED.subscription_ciphertext,updated_at=now()`, userID, hash, ciphertext)
	return err
}

func (service *pushService) deleteSubscription(ctx context.Context, userID uuid.UUID, endpoint string) error {
	if len(endpoint) > 2048 { return errors.New("invalid push endpoint") }
	_, err := service.db.Exec(ctx, `DELETE FROM room_push_subscriptions WHERE user_id=$1 AND endpoint_hash=$2`, userID, pushEndpointHash(strings.TrimSpace(endpoint)))
	return err
}

func (service *pushService) notifyRoom(ctx context.Context, roomID, senderID uuid.UUID, messageID uuid.UUID) error {
	var slug string
	if err := service.db.QueryRow(ctx, `SELECT slug FROM rooms WHERE id=$1 AND archived_at IS NULL`, roomID).Scan(&slug); err != nil {
		if errors.Is(err, pgx.ErrNoRows) { return nil }
		return err
	}
	query := `SELECT subscription.user_id,subscription.endpoint_hash,subscription.subscription_ciphertext
		FROM room_push_subscriptions subscription
		JOIN room_members member ON member.user_id=subscription.user_id JOIN users recipient ON recipient.id=subscription.user_id AND recipient.chat_notifications_enabled=TRUE
		WHERE member.room_id=$1 AND member.user_id<>$2`
	return service.sendForQuery(ctx, query, roomID, senderID, messageID, "/rooms/"+url.PathEscape(slug)+"?message_id="+messageID.String()+"#message-"+messageID.String())
}

func (service *pushService) notifyDirect(ctx context.Context, conversationID, senderID uuid.UUID, messageID uuid.UUID) error {
	query := `SELECT subscription.user_id,subscription.endpoint_hash,subscription.subscription_ciphertext
		FROM room_push_subscriptions subscription
		JOIN direct_conversation_members member ON member.user_id=subscription.user_id JOIN users recipient ON recipient.id=subscription.user_id AND recipient.chat_notifications_enabled=TRUE
		WHERE member.conversation_id=$1 AND member.user_id<>$2 AND member.hidden_at IS NULL`
	return service.sendForQuery(ctx, query, conversationID, senderID, messageID, "/rooms/direct/"+conversationID.String()+"?message_id="+messageID.String()+"#message-"+messageID.String())
}

func (service *pushService) sendForQuery(ctx context.Context, query string, conversationID, senderID, messageID uuid.UUID, path string) error {
	rows, err := service.db.Query(ctx, query, conversationID, senderID)
	if err != nil {
		return err
	}
	type target struct {
		hash, ciphertext []byte
	}
	targets := make([]target, 0)
	for rows.Next() {
		var userID uuid.UUID
		var item target
		if err := rows.Scan(&userID, &item.hash, &item.ciphertext); err != nil {
			rows.Close()
			return err
		}
		targets = append(targets, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	var lastErr error
	for _, item := range targets {
		if err := service.sendToTarget(ctx, item.hash, item.ciphertext, messageID, path); err != nil {
			lastErr = err
		}
	}
	return lastErr
}

func (service *pushService) sendToTarget(ctx context.Context, hash, ciphertext []byte, messageID uuid.UUID, path string) error {
	stored, err := service.decryptSubscription(hash, ciphertext)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(chatPushMessage{ID: messageID.String(), Path: path, Locale: stored.Locale})
	subscription := &webpush.Subscription{
		Endpoint: stored.Subscription.Endpoint,
		Keys: webpush.Keys{
			P256dh: stored.Subscription.Keys.P256dh,
			Auth:   stored.Subscription.Keys.Auth,
		},
	}
	response, err := webpush.SendNotificationWithContext(ctx, payload, subscription, &webpush.Options{
		Subscriber:      service.subject,
		VAPIDPublicKey:  service.publicKey,
		VAPIDPrivateKey: service.privateKey,
		TTL:             60,
	})
	if err != nil {
		return err
	}
	_ = response.Body.Close()
	if response.StatusCode == 404 || response.StatusCode == 410 {
		_, err := service.db.Exec(ctx, `DELETE FROM room_push_subscriptions WHERE endpoint_hash=$1`, hash)
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("push service returned HTTP %d", response.StatusCode)
	}
	return nil
}

func (handler *Handler) pushAfterRoomMessage(roomID, senderID, messageID uuid.UUID) {
	if !handler.push.isEnabled() { return }
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := handler.push.notifyRoom(ctx, roomID, senderID, messageID); err != nil {
			log.Warn().Err(err).Msg("rooms: push notification delivery failed")
		}
	}()
}

func (handler *Handler) pushAfterDirectMessage(conversationID, senderID, messageID uuid.UUID) {
	if !handler.push.isEnabled() { return }
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := handler.push.notifyDirect(ctx, conversationID, senderID, messageID); err != nil {
			log.Warn().Err(err).Msg("rooms: direct message push notification delivery failed")
		}
	}()
}
