package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/viper"
)

// Config holds all runtime configuration for the application.
// Values are loaded from environment variables (with .env file support).
type Config struct {
	// Server
	AppHost    string `mapstructure:"APP_HOST"`
	AppPort    int    `mapstructure:"APP_PORT"`
	AppBaseURL string `mapstructure:"APP_BASE_URL"`
	GoEnv      string `mapstructure:"GO_ENV"`

	// CORS
	CORSOrigins []string // parsed from CORS_ORIGINS (comma-separated)

	// Database
	PostgresHost     string `mapstructure:"POSTGRES_HOST"`
	PostgresPort     int    `mapstructure:"POSTGRES_PORT"`
	PostgresDB       string `mapstructure:"POSTGRES_DB"`
	PostgresUser     string `mapstructure:"POSTGRES_USER"`
	PostgresPassword string `mapstructure:"POSTGRES_PASSWORD"`
	PostgresSSLMode  string `mapstructure:"POSTGRES_SSLMODE"`

	// Redis
	RedisAddr     string `mapstructure:"REDIS_ADDR"`
	RedisPassword string `mapstructure:"REDIS_PASSWORD"`
	RedisDB       int    `mapstructure:"REDIS_DB"`

	// Storage paths
	FilesRoot       string `mapstructure:"FILES_ROOT"`
	BackupsRoot     string `mapstructure:"BACKUPS_ROOT"`
	TusUploadDir    string `mapstructure:"TUS_UPLOAD_DIR"`
	PreviewCacheDir string `mapstructure:"PREVIEW_CACHE_DIR"`

	// Security secrets — all required, no defaults
	SessionSecret    string `mapstructure:"SESSION_SECRET"`
	BackupHMACSecret string `mapstructure:"BACKUP_HMAC_SECRET"`
	BackupWrapKey    string `mapstructure:"BACKUP_WRAP_KEY"` // 32 hex bytes; wraps per-user ZIP key for scheduled backups

	TOTPEncryptKey    string `mapstructure:"TOTP_ENCRYPT_KEY"`
	DeviceTrustSecret string `mapstructure:"DEVICE_TRUST_SECRET"`

	// FileEncryptKey is an optional 64-char hex string (32 bytes) used to
	// encrypt file content at rest with AES-256-GCM. If empty, files are
	// stored in plaintext (backward-compatible). Set FILE_ENCRYPT_KEY to
	// enable. Existing unencrypted files are still readable; newly written
	// files (uploads, WebDAV PUT, OO saves) will be encrypted.
	FileEncryptKey string `mapstructure:"FILE_ENCRYPT_KEY"`

	// SMTP
	SMTPHost     string `mapstructure:"SMTP_HOST"`
	SMTPPort     int    `mapstructure:"SMTP_PORT"`
	SMTPUser     string `mapstructure:"SMTP_USER"`
	SMTPPassword string `mapstructure:"SMTP_PASSWORD"`
	SMTPFrom     string `mapstructure:"SMTP_FROM"`
	SMTPTLS      string `mapstructure:"SMTP_TLS"` // starttls | tls | none

	// Cloudflare
	CloudflareNetworkName string `mapstructure:"CLOUDFLARE_NETWORK_NAME"`

	// Trusted proxies — comma-separated CIDRs whose proxy headers (CF-Connecting-IP,
	// X-Forwarded-For) are honoured. Default: empty (trust no proxy headers).
	TrustedProxies []string // parsed from TRUSTED_PROXIES

	// Feature flags
	WebDAVEnabled        bool `mapstructure:"WEBDAV_ENABLED"`
	RegistrationOpen     bool `mapstructure:"REGISTRATION_OPEN"`
	TOTPRequiredForAdmin bool `mapstructure:"TOTP_REQUIRED_FOR_ADMIN"`

	// Gotenberg — Office document → PDF conversion service
	GotenbergURL string `mapstructure:"GOTENBERG_URL"`

	// Rate limiting defaults
	RLUserLockoutThreshold int           `mapstructure:"RL_USER_LOCKOUT_THRESHOLD"`
	RLUserLockoutDuration  time.Duration // parsed from RL_USER_LOCKOUT_DURATION_MIN
	RLIPThreshold60M       int           `mapstructure:"RL_IP_THRESHOLD_60M"`
	RLIPThreshold6H        int           `mapstructure:"RL_IP_THRESHOLD_6H"`
	RLIPThreshold24H       int           `mapstructure:"RL_IP_THRESHOLD_24H"`
	RLWindowSeconds        int           `mapstructure:"RL_WINDOW_SECONDS"`

	// Default quota
	DefaultQuotaBytes int64 `mapstructure:"DEFAULT_QUOTA_BYTES"`

	// Session
	SessionDuration     time.Duration
	DeviceTrustDuration time.Duration

	// Auth handler convenience fields (derived from RL_* and SESSION_* above)
	SessionIdleTimeout     time.Duration
	BaseURL                string
	CookieDomain           string // Explicit cookie domain. Empty = host-only (most secure default).
	RateLimitLoginAttempts int
	RateLimitLoginWindow   time.Duration
}

// Load reads configuration from environment variables and optional .env file.
// The path to the .env file can be overridden via the ENV_FILE environment variable.
func Load() (*Config, error) {
	v := viper.New()

	// Allow reading from environment variables
	v.AutomaticEnv()
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))

	bindExplicitEnvKeys(v)

	// Attempt to load .env file (fail silently if absent in production)
	envFile := v.GetString("ENV_FILE")
	if envFile == "" {
		envFile = ".env"
	}
	v.SetConfigFile(envFile)
	v.SetConfigType("dotenv")
	_ = v.ReadInConfig() // not fatal — env vars may be set directly

	setDefaults(v)

	cfg := &Config{}
	if err := v.Unmarshal(cfg); err != nil {
		return nil, fmt.Errorf("config unmarshal: %w", err)
	}

	applyDirectEnvOverrides(cfg)

	cfg.CORSOrigins = parseCommaSeparatedList(v.GetString("CORS_ORIGINS"))
	if len(cfg.CORSOrigins) == 0 {
		cfg.CORSOrigins = []string{"http://localhost:5173"}
	}
	cfg.TrustedProxies = parseCommaSeparatedList(v.GetString("TRUSTED_PROXIES"))

	applyDerivedValues(v, cfg)
	if err := validateRequiredConfig(cfg); err != nil {
		return nil, err
	}

	return cfg, nil
}
func bindExplicitEnvKeys(v *viper.Viper) {
	// Bind every env var that has no SetDefault — otherwise viper's Unmarshal
	// won't discover them via AutomaticEnv alone (it only iterates known keys).
	for _, key := range []string{
		"APP_BASE_URL",
		"POSTGRES_PASSWORD",
		"REDIS_PASSWORD",
		"SESSION_SECRET",
		"BACKUP_HMAC_SECRET",
		"BACKUP_WRAP_KEY",
		"TOTP_ENCRYPT_KEY",
		"DEVICE_TRUST_SECRET",
		"SMTP_HOST",
		"SMTP_USER",
		"SMTP_PASSWORD",
		"SMTP_FROM",
	} {
		_ = v.BindEnv(key)
	}
}

func setDefaults(v *viper.Viper) {
	v.SetDefault("APP_HOST", "0.0.0.0")
	v.SetDefault("APP_PORT", 8080)
	v.SetDefault("GO_ENV", "production")
	v.SetDefault("POSTGRES_HOST", "postgres")
	v.SetDefault("POSTGRES_PORT", 5432)
	v.SetDefault("POSTGRES_DB", "privatedrive")
	v.SetDefault("POSTGRES_USER", "privatedrive")
	v.SetDefault("POSTGRES_SSLMODE", "disable")
	v.SetDefault("REDIS_ADDR", "redis:6379")
	v.SetDefault("REDIS_DB", 0)
	v.SetDefault("FILES_ROOT", "/data/files")
	v.SetDefault("BACKUPS_ROOT", "")
	v.SetDefault("TUS_UPLOAD_DIR", "/data/files/tmp/uploads")
	v.SetDefault("PREVIEW_CACHE_DIR", "/data/preview-cache")
	v.SetDefault("SMTP_PORT", 587)
	v.SetDefault("SMTP_TLS", "starttls")
	v.SetDefault("WEBDAV_ENABLED", true)
	v.SetDefault("REGISTRATION_OPEN", false)
	v.SetDefault("TOTP_REQUIRED_FOR_ADMIN", true)
	v.SetDefault("RL_USER_LOCKOUT_THRESHOLD", 5)
	v.SetDefault("RL_USER_LOCKOUT_DURATION_MIN", 30)
	v.SetDefault("RL_IP_THRESHOLD_60M", 10)
	v.SetDefault("RL_IP_THRESHOLD_6H", 15)
	v.SetDefault("RL_IP_THRESHOLD_24H", 20)
	v.SetDefault("RL_WINDOW_SECONDS", 900)
	v.SetDefault("DEFAULT_QUOTA_BYTES", int64(10*1024*1024*1024)) // 10 GB
	v.SetDefault("CLOUDFLARE_NETWORK_NAME", "cloudflare-net")
	v.SetDefault("GOTENBERG_URL", "http://localhost:3000")
}

type stringEnvOverride struct {
	target *string
	key    string
}

func applyDirectEnvOverrides(cfg *Config) {
	// Override with direct env reads — viper's AutomaticEnv+Unmarshal does not
	// reliably populate fields that have no SetDefault when using uppercase keys.
	overrides := []stringEnvOverride{
		{target: &cfg.SessionSecret, key: "SESSION_SECRET"},
		{target: &cfg.BackupHMACSecret, key: "BACKUP_HMAC_SECRET"},
		{target: &cfg.TOTPEncryptKey, key: "TOTP_ENCRYPT_KEY"},
		{target: &cfg.DeviceTrustSecret, key: "DEVICE_TRUST_SECRET"},
		{target: &cfg.PostgresPassword, key: "POSTGRES_PASSWORD"},
		{target: &cfg.PostgresHost, key: "POSTGRES_HOST"},
		{target: &cfg.PostgresDB, key: "POSTGRES_DB"},
		{target: &cfg.PostgresUser, key: "POSTGRES_USER"},
		{target: &cfg.RedisAddr, key: "REDIS_ADDR"},
		{target: &cfg.AppBaseURL, key: "APP_BASE_URL"},
		{target: &cfg.SMTPHost, key: "SMTP_HOST"},
		{target: &cfg.SMTPUser, key: "SMTP_USER"},
		{target: &cfg.SMTPPassword, key: "SMTP_PASSWORD"},
		{target: &cfg.SMTPFrom, key: "SMTP_FROM"},
		{target: &cfg.BackupsRoot, key: "BACKUPS_ROOT"},
		{target: &cfg.FileEncryptKey, key: "FILE_ENCRYPT_KEY"},
	}
	for _, override := range overrides {
		if val := os.Getenv(override.key); val != "" {
			*override.target = val
		}
	}
}

func parseCommaSeparatedList(raw string) []string {
	values := make([]string, 0)
	for _, part := range strings.Split(raw, ",") {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			values = append(values, trimmed)
		}
	}
	return values
}

func applyDerivedValues(v *viper.Viper, cfg *Config) {
	lockoutMin := v.GetInt("RL_USER_LOCKOUT_DURATION_MIN")
	cfg.RLUserLockoutDuration = time.Duration(lockoutMin) * time.Minute
	cfg.SessionDuration = 7 * 24 * time.Hour
	cfg.DeviceTrustDuration = 30 * 24 * time.Hour
	cfg.SessionIdleTimeout = cfg.SessionDuration
	cfg.BaseURL = cfg.AppBaseURL
	// Cookie domain: explicit config value, or empty for host-only cookies (most secure).
	// Set COOKIE_DOMAIN=".example.com" only if cross-subdomain cookies are truly required.
	cfg.CookieDomain = strings.TrimSpace(os.Getenv("COOKIE_DOMAIN"))
	windowSec := v.GetInt("RL_WINDOW_SECONDS")
	if windowSec == 0 {
		windowSec = 60
	}
	cfg.RateLimitLoginWindow = time.Duration(windowSec) * time.Second
	cfg.RateLimitLoginAttempts = cfg.RLUserLockoutThreshold
	if cfg.RateLimitLoginAttempts == 0 {
		cfg.RateLimitLoginAttempts = 10
	}
}

func validateRequiredConfig(cfg *Config) error {
	required := map[string]string{
		"SESSION_SECRET":      cfg.SessionSecret,
		"BACKUP_HMAC_SECRET":  cfg.BackupHMACSecret,
		"TOTP_ENCRYPT_KEY":    cfg.TOTPEncryptKey,
		"DEVICE_TRUST_SECRET": cfg.DeviceTrustSecret,
		"POSTGRES_PASSWORD":   cfg.PostgresPassword,
	}
	for name, val := range required {
		if strings.TrimSpace(val) == "" {
			return fmt.Errorf("required config %s is not set", name)
		}
	}
	return nil
}

// IsDev returns true when running in development mode.
func (c *Config) IsDev() bool {
	return c.GoEnv == "development"
}

// PostgresDSN returns the pgx-compatible connection string.
func (c *Config) PostgresDSN() string {
	return fmt.Sprintf(
		"host=%s port=%d dbname=%s user=%s password=%s sslmode=%s",
		c.PostgresHost, c.PostgresPort, c.PostgresDB,
		c.PostgresUser, c.PostgresPassword, c.PostgresSSLMode,
	)
}

// ListenAddr returns the host:port string for the HTTP server.
func (c *Config) ListenAddr() string {
	return fmt.Sprintf("%s:%d", c.AppHost, c.AppPort)
}
