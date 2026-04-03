# PrivateDrive

A self-hosted, private file storage platform. OneDrive-inspired web UX, WebDAV support, granular sharing, 2FA, admin dashboard — packaged as a single Docker container.

## Features

- **Resumable uploads** via [tus protocol](https://tus.io/) — survives network interruptions
- **WebDAV** for native OS file system mappings (Windows, macOS, Linux)
- **Link/user/group sharing** with permissions (read, write, delete, share, download)
- **TOTP 2FA** with backup codes
- **Trusted devices** (30-day skip-2FA tokens)
- **Progressive rate limiting** — Redis sliding-window + automatic lockout tiers
- **Admin dashboard** — user management, quota, audit log, IP whitelist/block, group/tag management
- **Admin support sessions** — limited-scope access to a user account, fully audited
- **Backup/restore** — metadata JSON export (file content is NOT included)
- **Dark mode** — system-detected or manual toggle
- **Cloudflare Tunnel** — designed for reverse-proxy-free deployments

---

## Prerequisites

- Unraid (or any Linux + Docker Compose host)
- Existing [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) Docker network (or configure your own reverse proxy)
- A domain pointing at your Cloudflare Tunnel

---

## Quick start (Unraid / Docker Compose)

### 1. Clone and configure

```bash
git clone https://github.com/yourname/privatedrive /mnt/user/appdata/privatedrive/repo
cd /mnt/user/appdata/privatedrive/repo

cp .env.example .env
nano .env          # fill in secrets + your domain
```

Generate secrets:

```bash
openssl rand -hex 32   # run 4 times, paste into SESSION_SECRET, BACKUP_HMAC_SECRET, TOTP_ENCRYPT_KEY, DEVICE_TRUST_SECRET
```

### 2. Cloudflare Tunnel network

PrivateDrive joins your **existing** cloudflared tunnel network so no separate `cloudflared` container is needed. Check your tunnel compose for the network name and set it in `.env`:

```env
CLOUDFLARE_NETWORK_NAME=cloudflare-net   # default
```

In your Cloudflare dashboard → Zero Trust → Networks → Tunnels, add a public hostname:
- **Subdomain:** `drive`
- **Service:** `http://privatedrive-app:8080`

### 3. Build and start

```bash
make docker          # builds production image tagged with VERSION
docker compose up -d
```

Or pull a pre-built image (if published):

```bash
docker pull ghcr.io/yourname/privatedrive:latest
docker compose up -d
```

### 4. First-run setup

Open `https://drive.yourdomain.com`. If the database is empty you will be redirected to `/setup` to create the admin account. The wizard takes < 2 minutes.

---

## Development

Requires: Go 1.23+, Node 22+, Docker Compose.

```bash
# Start dev stack (hot reload for both frontend and backend)
make dev

# Frontend only
cd frontend && npm install && npm run dev

# Backend only (with air)
cd backend && air
```

The dev stack runs:
- Frontend Vite dev server on `:5173` (proxies `/api` to backend)
- Backend on `:8080` with Air live reload
- Postgres on `:5432`
- Redis on `:6379`

### Bump version

```bash
make bump            # increments build number, e.g. 2025-01-15-build-2
make docker          # builds and tags with new version
```

---

## WebDAV

WebDAV is available at `https://drive.yourdomain.com/dav/`.

1. In the web UI → user menu → "App Passwords" — generate a WebDAV-specific password
2. Map a network drive using your **email** as username and the app password

### Windows (File Explorer)

1. Right-click **This PC** → **Map network drive**
2. Folder: `\\drive.yourdomain.com@SSL\dav`
3. Credentials: email + app password

**Note:** Cloudflare free tier has a 100 MB upload limit on HTTP requests. For large WebDAV uploads, use a DNS-only record (bypasses Cloudflare proxy) or use the web UI (which uses tus for resumable uploads).

### macOS (Finder)

1. **Go** → **Connect to Server** (`⌘K`)
2. Server: `https://drive.yourdomain.com/dav/`

---

## Storage layout

```
/data/files/
  {first-2-chars-of-uuid}/
    {uuid}           # raw file bytes, zero metadata
```

File metadata (name, size, MIME type, owner) lives entirely in PostgreSQL. The storage path is opaque.

---

## Volumes (docker-compose.yml)

| Path in container | Purpose | Host path (example) |
|---|---|---|
| `/data/files` | File storage | `/mnt/user/data/privatedrive/files` |
| `/data/postgres` | PostgreSQL data | `/mnt/user/appdata/privatedrive/postgres` |

Redis data is **intentionally ephemeral** (no volume). It only holds rate-limit counters and pending 2FA sessions that are safe to lose on restart.

---

## Environment variables

See [`.env.example`](.env.example) for the full reference with descriptions.

---

## Architecture

```
┌─────────────────────────────────────┐
│           Cloudflare Tunnel         │
│         (existing container)        │
└──────────────┬──────────────────────┘
               │  cloudflare-net (Docker network)
┌──────────────▼──────────────────────┐
│        privatedrive-app:8080        │
│   Go binary (serves SPA + API)      │
│   ┌──────────┐  ┌────────────────┐  │
│   │  Chi API │  │  tus upload    │  │
│   │  /api/v1 │  │  endpoint      │  │
│   └──────────┘  └────────────────┘  │
│   ┌──────────┐  ┌────────────────┐  │
│   │  WebDAV  │  │  Embedded SPA  │  │
│   │  /dav/   │  │  (React/Vite)  │  │
│   └──────────┘  └────────────────┘  │
└───────────┬──────────────┬──────────┘
            │              │
   ┌────────▼──────┐  ┌────▼──────────┐
   │  PostgreSQL   │  │  Redis 7      │
   │  (15 tables)  │  │  (ephemeral)  │
   └───────────────┘  └───────────────┘
```

---

## Security

- Passwords: Argon2id
- TOTP secrets: AES-256-GCM at rest
- Sessions: opaque 256-bit tokens, SHA-256 stored in DB
- Rate limiting: Redis sorted-set sliding windows + progressive lockouts
- Headers: HSTS, CSP, X-Frame-Options, Referrer-Policy
- IP extraction: `CF-Connecting-IP` → `X-Forwarded-For` → `RemoteAddr`
- Audit log: immutable, never deleted by application code

---

## License

MIT
