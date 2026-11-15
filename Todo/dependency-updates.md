# Sharedrive: LTS-sikre afhængigheds-opdateringer

Status: Udkast — godkendelse fase for fase. Dato: 2026-11-15.

## Audit-resultat (2026-11-15)

### Base images (pinned i Fase 1)
| Overflade | Før | Efter |
|---|---|---|
| Node build | `node:24-alpine` (float) | `node:24.22.3-alpine` (Node 24 LTS, nyeste patch) |
| Go build | `golang:1.26-alpine` (float) | `golang:1.26.11-alpine` (Go 1.26 LTS, nyeste patch) |
| Runtime | `gotenberg/gotenberg:8` (float) | `gotenberg/gotenberg:8.40.0` (nyeste 8.x) |

### Go-moduler (backend/go.mod)
Opdateringer inden for major (LTS-bevaret):
- chi v5.3.0 → v5.5.0
- cors v1.2.1 → v1.2.2
- pgx v5.7.2 → v5.13.0
- go-redis v9.20.0 → v9.23.0
- zerolog v1.34.0 → v1.35.1
- viper v1.20.1 → v1.21.0
- tusd v2.9.2 → v2.10.1
- goose v3.24.1 → v3.30.1
- go-mail v0.7.3 → v0.8.2 (0.x: minor kan være breaking — test e-mail)
- x/crypto v0.52.0 → v0.59.0, x/net v0.55.0 → v0.62.0
- x/image v0.38.0 → v0.48.0, x/sys v0.45.0 → v0.50.0
- x/text v0.37.0 → v0.44.0, x/sync v0.20.0 → v0.25.0
- argon2id v1.0.0 og uuid v1.6.0 er allerede nyeste.
- webpush-go: ingen ny version publiceret (v1.4.0 er nyeste).

### npm (frontend, npm audit)
Produktion (8: 2 kritiske / 3 høje):
- zod 3.x → 4.6.7 (KRÆVER major bump — validerings-API)
- pdfjs-dist 5.x → 6.x (KRÆVER major bump — PDF-preview)
- monaco-editor 0.55 → 0.57 (KRÆVER major bump — code-editor)
- epubjs 0.3.93 → 0.4.2 (KRÆVER major bump; løser også dompurify/xmldom)
- fflate, seroval: transitive, fixbar in-range via npm audit --fix

Dev (alle fixbare in-range): vite 8.0.14 → 8.1.x, postcss → 8.5.x,
typescript-eslint → 8.72.x, nanoid, js-yaml, undici, sharp → 0.35.

## Udførelsesplan

### Fase 1 — Pin base images (godkendt 2026-11-15)
- [x] Dockerfile: 3 floating tags pinned til nyeste patch i samme major/LTS
- [ ] Verifikation: `make docker` bygger rent
- [ ] Smoke-test på testserveren: healthcheck, upload/download, Office→PDF, preview

### Fase 2 — Go-updates (to commits, begge inden for major)
- Commit A (patch-sikre): chi, cors, zerolog, x/crypto, x/net, x/image, x/sys, x/text, x/sync
- Commit B (potentielt brudende minors): go-mail 0.7→0.8, tusd 2.9→2.10, viper 1.20→1.21, pgx 5.7→5.13
- Verifikation pr. commit: `go build ./...`, `go test ./... -race`, `golangci-lint run`, `govulncheck`
- Bemærk: kræver lokal Go 1.26-toolchain (ikke installeret på denne maskine — Docker-build kan bruges som fallback)

### Fase 3 — npm in-range fixes
- Dev: vite → 8.1.x, postcss → 8.5.x, typescript-eslint → 8.72.x, nanoid, js-yaml, undici
- Prod transitive: `npm audit --fix` (fflate, seroval)
- Verifikation: `npm run build`, `npm run test`, `npm run lint`, manual: PDF-preview, code-editor, formulærvalidering

### Fase 4 — Major bumps (hvert for sig, med test)
1. epubjs 0.3 → 0.4.2 — test EPUB-læser (dompurify/xmldom løses med)
2. pdfjs-dist 5 → 6 — test PDF-preview (API-ændringer)
3. monaco-editor 0.55 → 0.57 — test code-editor
4. zod 3 → 4 — størst brud (formulærvalidering via @hookform/resolvers);
   hvis for stort: forbliv på zod 3 og acceptér advisory indtil v4-udgivelse

### Fase 5 — Udrulning (ifølge AGENTS.md)
1. Lokal verifikation færdig
2. Commit kun efter eksplisit godkendelse
3. `git push gitlab master` (alene gitlab — ALDRIG origin/GitHub)
4. Funktionel test på testserveren
5. Promotion til beta/latest = brugerens pipeline-valg

## Kontinuerligt
- CI: `govulncheck`, `npm audit --omit=dev` (fail på high/critical), `trivy image` mod final image
- Ingen floating tags fremover — pin altid til nyeste patch i ønsket major/LTS
- Månedlig tjekliste: npm audit + govulncheck + trivy

## Risiko (høj → lav)
- zod 4 + pdfjs 6: API-brud i UI-kode (størst)
- go-mail / tusd minor-brud (0.x-semver, tusd API)
- Gotenberg 8 → 8.40: samme LibreOffice-variant, minimal forventet risiko
