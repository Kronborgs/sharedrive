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
FROM golang:1.23-alpine AS backend-builder
ARG VERSION=dev
ARG BUILD_DATE=unknown

RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /src
COPY backend/go.mod ./
RUN go mod download

COPY backend/ .
RUN go mod tidy

# Embed the built frontend into the Go binary
COPY --from=frontend-builder /fe/dist ./internal/embed/dist

RUN go build \
    -ldflags "-X main.Version=${VERSION} -X main.BuildDate=${BUILD_DATE} -s -w" \
    -o /app/server ./cmd/server

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: Minimal runtime image
# ─────────────────────────────────────────────────────────────────────────────
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata && \
    adduser -D -u 1000 -g privatedrive privatedrive

WORKDIR /app

COPY --from=backend-builder /app/server /usr/local/bin/privatedrive

# Non-root user
USER privatedrive

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/v1/system/health || exit 1

ENTRYPOINT ["privatedrive"]
