VERSION := $(shell cat VERSION 2>/dev/null | tr -d '[:space:]' || echo "dev")
BUILD_DATE := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -X main.Version=$(VERSION) -X main.BuildDate=$(BUILD_DATE) -s -w

.PHONY: all version bump backend frontend docker docker-dev dev clean lint test migrate

# ── Info ────────────────────────────────────────────────────────────────────
version:
	@echo $(VERSION)

# ── Version ─────────────────────────────────────────────────────────────────
bump:
	@bash scripts/bump-version.sh 2>/dev/null || pwsh scripts/bump-version.ps1

# ── Backend ─────────────────────────────────────────────────────────────────
backend:
	cd backend && go build \
	  -ldflags "$(LDFLAGS)" \
	  -o bin/server ./cmd/server

backend-dev:
	cd backend && go run \
	  -ldflags "$(LDFLAGS)" \
	  ./cmd/server

lint-backend:
	cd backend && golangci-lint run ./...

test-backend:
	cd backend && go test ./... -race -timeout 60s

# ── Database migrations ──────────────────────────────────────────────────────
migrate:
	cd backend && go run ./cmd/migrate up

migrate-down:
	cd backend && go run ./cmd/migrate down

migrate-status:
	cd backend && go run ./cmd/migrate status

# ── sqlc codegen ─────────────────────────────────────────────────────────────
sqlc:
	cd backend && sqlc generate

# ── Frontend ─────────────────────────────────────────────────────────────────
frontend:
	cd frontend && APP_VERSION=$(VERSION) npm run build

frontend-dev:
	cd frontend && npm run dev

lint-frontend:
	cd frontend && npm run lint

# ── Docker ───────────────────────────────────────────────────────────────────
docker:
	docker build \
	  --build-arg VERSION=$(VERSION) \
	  --build-arg BUILD_DATE=$(BUILD_DATE) \
	  -t privatedrive:$(VERSION) \
	  -t privatedrive:latest \
	  -f Dockerfile .

docker-dev:
	docker compose -f docker-compose.dev.yml up --build

# ── Production (Unraid) ───────────────────────────────────────────────────────
up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f app

# ── Dev (local hot-reload) ────────────────────────────────────────────────────
dev:
	docker compose -f docker-compose.dev.yml up

# ── Clean ─────────────────────────────────────────────────────────────────────
clean:
	rm -rf backend/bin frontend/dist

all: bump backend frontend
