# Unraid Templates

Three Community Applications templates for deploying Sharedrive on Unraid.

## Deployment order

Deploy containers **in this order**:

1. **`sharedrive-postgres`** — PostgreSQL 16 database
2. **`sharedrive-redis`** — Redis 7 in-memory store
3. **`sharedrive`** — Main application (app + embedded frontend)

## Prerequisites

Create the two required Docker networks before adding any containers:

```bash
docker network create privatedrive-net
# The "cloudflare" network already exists if you run a cloudflared container
```

## Configuration

Before starting the `sharedrive` container, copy `.env.example` from the repository root to
your chosen config path (default: `/mnt/user/appdata/sharedrive/config/.env`) and fill in all
required values. See `.env.example` for documentation on each variable.

## Templates

| File | Image | Purpose |
|---|---|---|
| `sharedrive.xml` | `ghcr.io/kronborgs/sharedrive:latest` | App + embedded frontend |
| `sharedrive-postgres.xml` | `postgres:16-alpine` | Relational database |
| `sharedrive-redis.xml` | `redis:7-alpine` | Rate limiting / sessions |
