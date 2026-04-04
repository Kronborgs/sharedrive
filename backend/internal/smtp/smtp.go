package smtp

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	mail "github.com/wneessen/go-mail"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/yourname/privatedrive/internal/config"
)

// Mailer sends transactional email using wneessen/go-mail.
// It implements auth.Mailer so it can be injected into auth.Handler.
type Mailer struct {
	cfg *config.Config
	db  *pgxpool.Pool // optional — when set, DB settings override cfg
}

// New creates a Mailer. When db is non-nil, SMTP settings are loaded from the
// system_settings table at send time (Admin UI settings take precedence over env vars).
func New(cfg *config.Config, db *pgxpool.Pool) *Mailer {
	return &Mailer{cfg: cfg, db: db}
}

// smtpSettings holds resolved SMTP configuration from either DB or cfg.
type smtpSettings struct {
	host, user, password, from, tls string
	port                            int
}

// loadSettings reads SMTP config from DB if available, otherwise falls back to cfg.
func (m *Mailer) loadSettings(ctx context.Context) (smtpSettings, error) {
	s := smtpSettings{
		host:     m.cfg.SMTPHost,
		port:     m.cfg.SMTPPort,
		user:     m.cfg.SMTPUser,
		password: m.cfg.SMTPPassword,
		from:     m.cfg.SMTPFrom,
		tls:      m.cfg.SMTPTLS,
	}
	if m.db != nil {
		rows, err := m.db.Query(ctx, `SELECT key, value FROM system_settings WHERE key LIKE 'smtp_%'`)
		if err == nil {
			defer rows.Close()
			kv := map[string]string{}
			for rows.Next() {
				var k, v string
				if rows.Scan(&k, &v) == nil {
					kv[k] = v
				}
			}
			if v := kv["smtp_host"]; v != "" {
				s.host = v
			}
			if v := kv["smtp_port"]; v != "" {
				if p, err := strconv.Atoi(v); err == nil {
					s.port = p
				}
			}
			if v := kv["smtp_user"]; v != "" {
				s.user = v
			}
			if v := kv["smtp_password"]; v != "" {
				s.password = v
			}
			if v := kv["smtp_from"]; v != "" {
				s.from = v
			}
			if v := kv["smtp_tls"]; v != "" {
				s.tls = v
			}
		}
	}
	if s.host == "" {
		return s, fmt.Errorf("smtp: SMTP_HOST not configured")
	}
	return s, nil
}

// SendPasswordReset sends the pre-constructed reset link to the given address.
func (m *Mailer) SendPasswordReset(_ context.Context, toEmail, toName, resetLink string) error {
	body := fmt.Sprintf(
		"Hi %s,\n\n"+
			"You requested a password reset for your PrivateDrive account.\n\n"+
			"Click the link below to set a new password (valid for 1 hour):\n\n%s\n\n"+
			"If you did not request this, you can safely ignore this email.\n",
		toName, resetLink,
	)
	return m.send(toEmail, "Reset your PrivateDrive password", body)
}

// SendInvitation sends an invitation link to a new user.
func (m *Mailer) SendInvitation(_ context.Context, toEmail, inviterName, inviteLink string) error {
	body := fmt.Sprintf(
		"%s has invited you to join PrivateDrive.\n\n"+
			"Click the link below to set up your account (valid for 7 days):\n\n%s\n",
		inviterName, inviteLink,
	)
	return m.send(toEmail, fmt.Sprintf("%s has invited you to PrivateDrive", inviterName), body)
}

// SendShareNotification notifies a user that a file has been shared with them.
func (m *Mailer) SendShareNotification(_ context.Context, toEmail, sharerName, fileName, appURL string) error {
	body := fmt.Sprintf(
		"Hi,\n\n"+
			"%s has shared a file with you on PrivateDrive: \"%s\"\n\n"+
			"Log in to view it:\n\n%s\n\n"+
			"You can find all files shared with you under \"Shared with me\".\n",
		sharerName, fileName, appURL,
	)
	return m.send(toEmail, fmt.Sprintf("%s shared \"%s\" with you", sharerName, fileName), body)
}

// SendShareInvite sends a combined share + sign-up invitation to someone without an account.
func (m *Mailer) SendShareInvite(_ context.Context, toEmail, sharerName, fileName, inviteLink string) error {
	body := fmt.Sprintf(
		"Hi,\n\n"+
			"%s wants to share a file with you on PrivateDrive: \"%s\"\n\n"+
			"Create a free account to access it — the link below is valid for 7 days:\n\n%s\n\n"+
			"Once you have signed up, the file will appear under \"Shared with me\".\n",
		sharerName, fileName, inviteLink,
	)
	return m.send(toEmail, fmt.Sprintf("%s shared \"%s\" with you on PrivateDrive", sharerName, fileName), body)
}

func (m *Mailer) send(to, subject, body string) error {
	s, err := m.loadSettings(context.Background())
	if err != nil {
		return err
	}

	var opts []mail.Option
	opts = append(opts, mail.WithPort(s.port))
	opts = append(opts, mail.WithTimeout(15*time.Second))

	switch strings.ToLower(s.tls) {
	case "tls":
		opts = append(opts, mail.WithSSL())
	case "starttls":
		opts = append(opts, mail.WithTLSPolicy(mail.TLSMandatory))
	default: // "none"
		opts = append(opts, mail.WithTLSPolicy(mail.NoTLS))
	}

	if s.user != "" {
		opts = append(opts,
			mail.WithUsername(s.user),
			mail.WithPassword(s.password),
			mail.WithSMTPAuth(mail.SMTPAuthPlain),
		)
	}

	client, err := mail.NewClient(s.host, opts...)
	if err != nil {
		return fmt.Errorf("smtp: create client: %w", err)
	}

	msg := mail.NewMsg()
	if err := msg.From(s.from); err != nil {
		return fmt.Errorf("smtp: invalid from address: %w", err)
	}
	if err := msg.To(to); err != nil {
		return fmt.Errorf("smtp: invalid to address: %w", err)
	}
	msg.Subject(subject)
	msg.SetBodyString(mail.TypeTextPlain, body)

	if err := client.DialAndSend(msg); err != nil {
		return fmt.Errorf("smtp: send: %w", err)
	}
	return nil
}
