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
npm run test:coverage
npm run lint
npm run build
```

Frontend-tests genererer `frontend/coverage/lcov.info`, som SonarQube importerer sammen med Go-rapporten. Nye upload-routing- og fallback-grene er dækket af fokuserede unit tests.

## Scan med SonarScanner

Når testene er kørt, kan du scanne repoet fra roden af workspace. Hvis `sonar-scanner` ikke er installeret lokalt, er den nemmeste vej at bruge Docker.

### Lokal SonarScanner CLI

```powershell
# Indlæs SONAR_TOKEN fra en sikker secret store eller en maskeret CI/CD-variabel.
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

Pipeline har separate `backend:test` og `frontend:test` jobs. `sonar:scan` venter på begge jobs og importerer både `backend/coverage.out` og `frontend/coverage/lcov.info`.
Scanneren venter også på Quality Gate-resultatet og fejler pipeline-jobbet, hvis New Code ikke opfylder kravene.

Sæt disse CI/CD variabler i GitLab-projektet:

- `SONAR_TOKEN` (Masked + Protected anbefales)
- `SONAR_HOST_URL` (valgfri, hvis du vil override; ellers bruges værdien fra `sonar-project.properties`)

Kørsel i GitLab betyder, at du ikke behøver lokal `sonar-scanner` eller lokal Docker for at få analyserne ind i SonarQube.

## Praktisk flow

1. Kør backend-tests og generer `backend/coverage.out`.
2. Kør frontend coverage, lint og build.
3. Kør `sonar-scanner` fra repo-roden.
4. Tjek især Quality Gate for New Code i SonarQube-dashboardet.

## Noter

- Projektkey er sat til `sharedrive`.
- Versionsnummeret følger filen `VERSION` i repo-roden.