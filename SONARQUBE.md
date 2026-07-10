# SonarQube for Sharedrive

Denne repo-konfiguration er lavet til SonarQube Community Build på `http://10.10.80.6:9000`.

## Hvad der scannes

- Backend i `backend/`
- Frontend-kode i `frontend/src/`
- Go-tests i `backend/**/*_test.go`

Genererede filer og build-output er ekskluderet, så rapporten fokuserer på koden, der vedligeholdes manuelt.

## Lokale tests

Kør disse kommandoer før du laver en Sonar-scan:

```powershell
cd backend
go test ./... -timeout 60s -coverprofile=coverage.out
```

Hvis du også vil køre race-detektion på Windows, skal `CGO_ENABLED=1` være sat, og der skal være en C-kompiler installeret. Det er derfor ikke en del af standardflowet for Sonar-opsætningen.

```powershell
cd frontend
npm ci
npm run lint
npm run build
```

Der er pt. ingen frontend unit tests i repoet, så SonarQube får kun Go-coveragerapporten fra backend.

## Scan med SonarScanner

Når testene er kørt, kan du scanne repoet fra roden af workspace. Hvis `sonar-scanner` ikke er installeret lokalt, er den nemmeste vej at bruge Docker.

### Lokal SonarScanner CLI

```powershell
$env:SONAR_TOKEN = "din-token-her"
sonar-scanner
```

### Docker-baseret scanner

```powershell
docker run --rm `
	-e SONAR_HOST_URL=http://10.10.80.6:9000 `
	-e SONAR_TOKEN=$env:SONAR_TOKEN `
	-v "${PWD}:/usr/src" `
	-w /usr/src `
	sonarsource/sonar-scanner-cli
```

Hvis din scanner ikke automatisk finder projektet, skal du sikre, at den køres fra repo-roden, hvor `sonar-project.properties` ligger.

`backend/coverage.out` er en filsti til coverage-rapporten, ikke en kommando. Den bliver læst af SonarScanner under scanningen.

## GitLab CI (anbefalet)

Hvis I kører builds i GitLab, skal I vælge **With GitLab CI** i SonarQube onboarding.

Pipeline er nu opdateret med en `sonar:scan` job i `.gitlab-ci.yml` (køres efter `backend:test` og bruger `backend/coverage.out`).

Sæt disse CI/CD variabler i GitLab-projektet:

- `SONAR_TOKEN` (Masked + Protected anbefales)
- `SONAR_HOST_URL` (valgfri, hvis du vil override; ellers bruges værdien fra `sonar-project.properties`)

Kørsel i GitLab betyder, at du ikke behøver lokal `sonar-scanner` eller lokal Docker for at få analyserne ind i SonarQube.

## Praktisk flow

1. Kør backend-tests og generer `backend/coverage.out`.
2. Kør frontend lint og build.
3. Kør `sonar-scanner` fra repo-roden.
4. Tjek resultatet i SonarQube-dashboardet.

## Noter

- Projektkey er sat til `sharedrive`.
- Versionsnummeret følger filen `VERSION` i repo-roden.