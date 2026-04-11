# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build frontend
# ─────────────────────────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend-builder
ARG VERSION=dev

WORKDIR /fe
COPY frontend/package*.json ./
RUN npm install --prefer-offline
COPY frontend/ .
RUN APP_VERSION=${VERSION} npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Build backend (embeds frontend dist)
# ─────────────────────────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS backend-builder
ARG VERSION=dev
ARG BUILD_DATE=unknown
ARG TARGETOS=linux
ARG TARGETARCH=amd64

RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ .
RUN go mod tidy

# Embed the built frontend into the Go binary
COPY --from=frontend-builder /fe/dist ./internal/embed/dist

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build \
    -ldflags "-X main.Version=${VERSION} -X main.BuildDate=${BUILD_DATE} -s -w" \
    -o /app/server ./cmd/server

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: Final runtime — Gotenberg image includes LibreOffice for Office → PDF
# ─────────────────────────────────────────────────────────────────────────────
FROM gotenberg/gotenberg:8

USER root

# Create a sharedrive user (uid 1000) — matches ownership of existing host-mounted
# data directories. Gotenberg only requires non-root, any uid works.
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -g 1000 sharedrive && \
    useradd -u 1000 -g 1000 -m -s /sbin/nologin sharedrive && \
    mkdir -p /data/files /data/backups /data/preview-cache && \
    chown -R 1000:1000 /data

WORKDIR /app

COPY --from=backend-builder /app/server /usr/local/bin/privatedrive
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Default to uid 1000 — can be overridden at runtime with --user if the
# host bind-mounts require a different uid (e.g. USB drives owned by root).
USER 1000

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://localhost:8080/api/v1/system/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
