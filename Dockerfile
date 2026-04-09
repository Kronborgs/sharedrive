# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build frontend
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS frontend-builder
ARG VERSION=dev

WORKDIR /fe
COPY frontend/package*.json ./
RUN npm install --prefer-offline
COPY frontend/ .
RUN APP_VERSION=${VERSION} npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Build backend (embeds frontend dist)
# ─────────────────────────────────────────────────────────────────────────────
FROM golang:1.25-alpine AS backend-builder
ARG VERSION=dev
ARG BUILD_DATE=unknown

RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ .
RUN go mod tidy

# Embed the built frontend into the Go binary
COPY --from=frontend-builder /fe/dist ./internal/embed/dist

RUN go build \
    -ldflags "-X main.Version=${VERSION} -X main.BuildDate=${BUILD_DATE} -s -w" \
    -o /app/server ./cmd/server

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: Final runtime — Gotenberg image includes LibreOffice for Office → PDF
# ─────────────────────────────────────────────────────────────────────────────
FROM gotenberg/gotenberg:8

USER root

# Install curl (for healthcheck) and create data directories owned by
# the gotenberg user (uid 1001) that the container runs as.
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /data/files /data/backups /data/preview-cache && \
    chown -R 1001:1001 /data

WORKDIR /app

COPY --from=backend-builder /app/server /usr/local/bin/privatedrive
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Run as the gotenberg user (non-root) — required for LibreOffice sandboxing
USER 1001

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://localhost:8080/api/v1/system/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
