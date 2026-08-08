package smtp

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	mail "github.com/wneessen/go-mail"

	"github.com/yourname/privatedrive/internal/config"
	"github.com/yourname/privatedrive/internal/notes"
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
	settings := defaultSMTPSettings(m.cfg)
	if m.db != nil {
		if overrides, err := m.loadDBSettings(ctx); err == nil {
			applySMTPOverrides(&settings, overrides)
		}
	}
	if settings.host == "" {
		return settings, fmt.Errorf("smtp: SMTP_HOST not configured")
	}
	return settings, nil
}

func defaultSMTPSettings(cfg *config.Config) smtpSettings {
	return smtpSettings{
		host:     cfg.SMTPHost,
		port:     cfg.SMTPPort,
		user:     cfg.SMTPUser,
		password: cfg.SMTPPassword,
		from:     cfg.SMTPFrom,
		tls:      cfg.SMTPTLS,
	}
}

func (m *Mailer) loadDBSettings(ctx context.Context) (map[string]string, error) {
	rows, err := m.db.Query(ctx, `SELECT key, value FROM system_settings WHERE key LIKE 'smtp_%'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	settings := map[string]string{}
	for rows.Next() {
		var key, value string
		if rows.Scan(&key, &value) == nil {
			settings[key] = value
		}
	}
	return settings, nil
}

func applySMTPOverrides(settings *smtpSettings, overrides map[string]string) {
	if value := overrides["smtp_host"]; value != "" {
		settings.host = value
	}
	if value := overrides["smtp_port"]; value != "" {
		if port, err := strconv.Atoi(value); err == nil {
			settings.port = port
		}
	}
	if value := overrides["smtp_user"]; value != "" {
		settings.user = value
	}
	if value := overrides["smtp_password"]; value != "" {
		settings.password = value
	}
	if value := overrides["smtp_from"]; value != "" {
		settings.from = value
	}
	if value := overrides["smtp_tls"]; value != "" {
		settings.tls = value
	}
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
			"Log in to view it:\n\n%s/shares\n\n"+
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

// SendNoteInvitation invites an accountless guest to a single note without including note content.
func (m *Mailer) SendNoteInvitation(_ context.Context, invitation notes.NoteInvitation) error {
	permissionText := map[string]string{"view": "Can view", "check": "Can check items", "edit": "Can edit"}[invitation.Permission]
	expiryText := ""
	if invitation.ExpiresAt != nil {
		expiryText = fmt.Sprintf("\nAccess expires: %s\n", invitation.ExpiresAt.UTC().Format("02 Jan 2006 15:04 UTC"))
	}
	subject := fmt.Sprintf("%s shared a note with you on Sharedrive", invitation.OwnerName)
	body := fmt.Sprintf("Hi,\n\n%s shared the note \"%s\" with you.\nPermission: %s\n%s\nOpen note:\n%s\n\nYou do not need an account. Do not forward this private link.\n", invitation.OwnerName, invitation.NoteTitle, permissionText, expiryText, invitation.InviteLink)
	if invitation.Language == "da" {
		permissionText = map[string]string{"view": "Kan se", "check": "Kan afkrydse", "edit": "Kan redigere"}[invitation.Permission]
		expiryText = ""
		if invitation.ExpiresAt != nil {
			expiryText = fmt.Sprintf("\nAdgangen udløber: %s\n", invitation.ExpiresAt.Local().Format("02-01-2006 15:04"))
		}
		subject = fmt.Sprintf("%s har delt en note med dig på Sharedrive", invitation.OwnerName)
		body = fmt.Sprintf("Hej,\n\n%s har delt noten \"%s\" med dig.\nRettighed: %s\n%s\nÅbn noten:\n%s\n\nDu behøver ikke en konto. Videresend ikke dette private link.\n", invitation.OwnerName, invitation.NoteTitle, permissionText, expiryText, invitation.InviteLink)
	}
	return m.send(invitation.ToEmail, subject, body)
}

// SendBackupFailure notifies a user that one of their automatic backups has been
// failing for more than 24 hours.
// backupType is a short human-readable label ("Server backup" or "Buddy backup").
// detail is extra context (peer URL for buddy, empty for tertiary).
func (m *Mailer) SendBackupFailure(_ context.Context, toEmail, toName, backupType, detail string, failedSince time.Time) error {
	hours := int(time.Since(failedSince).Hours())
	detailLine := ""
	if detail != "" {
		detailLine = fmt.Sprintf("Peer server: %s\n", detail)
	}
	body := fmt.Sprintf(
		"Hej %s,\n\n"+
			"Din Sharedrive %s har fejlet i over %d timer.\n\n"+
			"%s"+
			"Fejl siden: %s\n\n"+
			"Backup vil automatisk forsøge igen ved næste planlagte kørsel.\n"+
			"Kontroller at serveren er tilgængelig og konfigurationen er korrekt.\n\n"+
			"Du kan slå denne notifikation fra under Backup-siden.\n",
		toName, backupType, hours, detailLine, failedSince.Format("02 Jan 2006 15:04 UTC"),
	)
	return m.send(toEmail, fmt.Sprintf("%s fejlede — ikke lykkedes i %d timer", backupType, hours), body)
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
