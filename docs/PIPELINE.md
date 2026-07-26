# Sharedrive CI/CD-pipeline

Sharedrive bygges og publiceres af GitLab CI fra `.gitlab-ci.yml`. GitLab er
den primære Git-server og container registry. GitHub kan opdateres manuelt fra
pipeline-siden.

## Pipelineforløb

Pipelinen kører ved pushes, merge requests og versionstags.

1. `backend:test` kører Go-tests og opretter `backend/coverage.out`.
2. `sonar:scan` sender testresultater og kildekode til SonarQube.
3. `backend:build` kontrollerer, at Go-serveren kan bygges.
4. `frontend:build` kører TypeScript-kontrol og bygger frontenden.
5. `docker:publish` genererer changelog, bygger produktionsimaget og sender
   det til GitLab Container Registry.
6. `publish_to_github` kan startes manuelt og sender den aktuelle `master`
   eller det aktuelle versionstag til GitHub.

## Runner

Jobbene kører med Docker executor. Runneren på Unraid skal kunne køre
utaggede jobs og have Docker-socketten tilgængelig både i runner-containeren
og dens job-containere:

```toml
[runners.docker]
  image = "alpine:latest"
  volumes = [
    "/cache",
    "/var/run/docker.sock:/var/run/docker.sock"
  ]
```

`docker:publish` sætter `DOCKER_HOST=unix:///var/run/docker.sock`, så jobbet
bruger Unraid-værtens Docker-daemon og ikke forventer en Docker-in-Docker
service på `docker:2375`.

## Build-info og changelog

Før produktionsimaget bygges, kører pipelinen:

```bash
bash scripts/generate-changelog.sh 30
```

Generatoren skriver de seneste 30 commits til
`frontend/src/changelog.generated.ts`. Filen kopieres ind i Docker-buildets
frontend-stage og bliver dermed en del af den frontend, som Go-serveren
embedder.

GitLab-jobbet sender samtidig disse build-args til Docker:

```text
VERSION=<tag uden v, eller branch-kort-commit>
BUILD_DATE=<pipeline-oprettelsestidspunkt i ISO 8601>
```

Dockerfilen bruger `VERSION` både til frontendens `APP_VERSION` og til
Go-serverens `main.Version`. `BUILD_DATE` indlejres som Go-serverens
`main.BuildDate`. API-endpointet `/api/v1/system/version` returnerer serverens
version og build-dato, mens frontendens build-info-dialog viser værdierne
sammen med det genererede changelog.

Eksempler:

```text
master-a9e153f
2.1.0
```

Et versionstag som `v2.1.0` bliver altså vist som version `2.1.0`.

## Container-tags

Ved push til standardbranchen publiceres:

```text
latest
<kort commit-hash>
```

Ved et SemVer-tag som `v2.1.0` publiceres:

```text
2.1.0
latest
```

## Nødvendige CI/CD-variabler

Følgende variabler leveres automatisk af GitLab Container Registry:

```text
CI_REGISTRY
CI_REGISTRY_IMAGE
CI_REGISTRY_USER
CI_REGISTRY_PASSWORD
```

Disse projektvariabler skal oprettes manuelt, hvis de tilhørende jobs bruges:

```text
SONAR_TOKEN
GITHUB_TOKEN
```

Tokens skal gemmes under **Settings → CI/CD → Variables** og må ikke
committes til repository’et.

## Udgivelse

En almindelig master-build startes med et push:

```bash
git push gitlab master
```

En versioneret udgivelse oprettes med et annoteret tag:

```bash
git tag -a v2.1.0 -m "Sharedrive 2.1.0"
git push gitlab v2.1.0
```

Efter et succesfuldt `docker:publish` kan den manuelle
`publish_to_github`-opgave bruges fra GitLabs pipeline-side.

## Fejlsøgning

- `Version dev / bygget unknown`: Docker-buildet mangler `VERSION` eller
  `BUILD_DATE`.
- Changeloget er gammelt: kontrollér, at `generate-changelog.sh` kørte før
  `docker build`, og at det nye image faktisk blev publiceret og installeret.
- `lookup docker ... no such host`: jobbet forsøger at bruge
  `tcp://docker:2375`; kontrollér `DOCKER_HOST`.
- `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`:
  kontrollér runnerens socket-mount og `volumes` i `config.toml`.
