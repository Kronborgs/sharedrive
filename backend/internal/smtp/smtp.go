package smtp

import (
	"context"
	"fmt"
	"strings"
	"time"

	mail "github.com/wneessen/go-mail"

	"github.com/yourname/privatedrive/internal/config"
)

// Mailer sends transactional email using wneessen/go-mail.
// It implements auth.Mailer so it can be injected into auth.Handler.
type Mailer struct {
	cfg *config.Config
}

// New creates a Mailer. cfg.SMTPHost must be non-empty to send real mail.
func New(cfg *config.Config) *Mailer {
	return &Mailer{cfg: cfg}
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

func (m *Mailer) send(to, subject, body string) error {
	if m.cfg.SMTPHost == "" {
		return fmt.Errorf("smtp: SMTP_HOST not configured")
	}

	var opts []mail.Option
	opts = append(opts, mail.WithPort(m.cfg.SMTPPort))
	opts = append(opts, mail.WithTimeout(15*time.Second))

	switch strings.ToLower(m.cfg.SMTPTLS) {
	case "tls":
		opts = append(opts, mail.WithSSL())
	case "starttls":
		opts = append(opts, mail.WithTLSPolicy(mail.TLSMandatory))
	default: // "none"
		opts = append(opts, mail.WithTLSPolicy(mail.NoTLS))
	}

	if m.cfg.SMTPUser != "" {
		opts = append(opts,
			mail.WithUsername(m.cfg.SMTPUser),
			mail.WithPassword(m.cfg.SMTPPassword),
			mail.WithSMTPAuth(mail.SMTPAuthPlain),
		)
	}

	client, err := mail.NewClient(m.cfg.SMTPHost, opts...)
	if err != nil {
		return fmt.Errorf("smtp: create client: %w", err)
	}

	msg := mail.NewMsg()
	if err := msg.From(m.cfg.SMTPFrom); err != nil {
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
