# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build frontend
# ─────────────────────────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:24.22.3-alpine AS suite-ui-builder
WORKDIR /frontend/suite
COPY frontend/suite/package.json frontend/suite/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/suite/ ./
COPY frontend/src/lib/file-types.ts frontend/src/lib/share-mail-draft.ts frontend/src/lib/theme-palettes.ts frontend/src/lib/offline-mail-storage.ts /frontend/src/lib/
RUN npm run build

FROM --platform=$BUILDPLATFORM node:24.22.3-alpine AS frontend-builder
ARG VERSION=dev

WORKDIR /fe
COPY frontend/package*.json ./
RUN npm install --prefer-offline
COPY frontend/ .
COPY --from=suite-ui-builder /frontend/suite/dist ./public/mail/suite-ui
RUN APP_VERSION=${VERSION} npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Build backend (embeds frontend dist)
# ─────────────────────────────────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM golang:1.26.11-alpine AS backend-builder
ARG VERSION=dev
ARG BUILD_DATE=unknown
ARG TARGETOS
ARG TARGETARCH

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
FROM node:22.22.0-bookworm-slim AS mailcow-runtime
WORKDIR /opt/sharedrive-mailcow
COPY services/mailcow/package.json services/mailcow/package-lock.json ./
RUN npm ci --ignore-scripts
COPY services/mailcow/src ./src
COPY services/mailcow/suite/src ./suite/src
RUN npm run build:suite && npm prune --omit=dev --ignore-scripts

FROM gotenberg/gotenberg:8.40.0

USER root

# Create a sharedrive user (uid 1000) — matches ownership of existing host-mounted
# data directories. Gotenberg only requires non-root, any uid works.
RUN apt-get update && apt-get install -y --no-install-recommends curl gosu libstdc++6 && \
    rm -rf /var/lib/apt/lists/* && \
    # Create su-exec compatible wrapper using gosu (Debian alternative)
    ln -sf /usr/sbin/gosu /usr/local/bin/su-exec && \
    groupadd -g 1000 sharedrive && \
    useradd -u 1000 -g 1000 -m -s /sbin/nologin sharedrive && \
    mkdir -p /data/files /data/backups /data/preview-cache && \
    chown -R 1000:1000 /data

WORKDIR /app

COPY --from=backend-builder /app/server /usr/local/bin/privatedrive
COPY --from=mailcow-runtime /usr/local/bin/node /usr/local/bin/sharedrive-node
COPY --from=mailcow-runtime /opt/sharedrive-mailcow /opt/sharedrive-mailcow
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Entrypoint runs init as root (mkdir, chown) then drops to uid 1000 (sharedrive)
# via su-exec/gosu before starting the application process.

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://localhost:8080/api/v1/system/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
