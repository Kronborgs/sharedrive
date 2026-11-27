# Lokal Mailcow-forbindelsesprøve

Denne interne Node-tjeneste er et første trin til Mail, Kalender og Kontakter i Sharedrive. Den lytter på `127.0.0.1`. Sharedrives Go-backend giver administratorer adgang til prøven fra SMTP-indstillingerne.

## Kør lokalt

Kør `npm ci`, `npm test` og `npm start` fra `services/mailcow` med Node 22.22.0 eller nyere. Angiv følgende miljøvariabler før start. Go-processen og Node skal dele samme loopback-adresse og bruge samme token og port.

| Variabel | Værdi |
| --- | --- |
| `SHAREDRIVE_MAILCOW_TOKEN` | Lokal tjenestetoken med mindst 32 URL-sikre tegn |
| `SHAREDRIVE_MAILCOW_PORT` | Valgfri lokal port, standard 3025 |
| `SHAREDRIVE_MAILCOW_SMTP_PORT` | 465 med TLS som standard, eller 587 med STARTTLS |

`GET /healthz` viser, at tjenesten kører. Åbn Administration → Indstillinger → SMTP → Mailcow-forbindelse i Sharedrive. Gem serverens DNS-værtsnavn, og prøv to separate testkonti med deres applikationsadgangskoder. Go læser den gemte vært og sender den sammen med testkontoen til den interne Node-tjeneste. Tjenesten bruger et offentligt IPv4-resultat fra DNS og validerer TLS-certifikatet mod det gemte værtsnavn. Adgangskoden gemmes ikke af testen.

Eksempel på svar:

```json
{"imap":"ok","smtp":"ok","caldav":"ok","carddav":"ok"}
```

Hver protokol returnerer `ok` eller `failed`. Prøven viser, om kontoen kan hente sin liste over IMAP-mapper, godkende sig til SMTP og finde en læsbar SOGo-kalender og adressebog. DAV-prøven kontrollerer både samlingstypen og status for egenskaben i DAV-svaret. SMTP-prøven sender ingen mail. DAV-prøven ændrer ingen kalenderaftaler eller kontakter. Se [arbejdsplanen](../../docs/sharedrive-mailcow-plan.md) for næste etape med adskilte testkonti og skrivning.

## Kontotilknytning for en Sharedrive-bruger

Åbn **Min Mailcow-konto** i brugermenuen. Gem din egen Mailcow-vært, e-mailadresse og applikationsadgangskode. Brug **Test forbindelse** til at kontrollere den gemte konto, og **Frakobl konto** for at fjerne den fra Sharedrive. Flere brugere kan bruge hver sin offentlige Mailcow-vært. Administratorens testvært er uafhængig af disse konti.

Go krypterer adgangskoderne med en separat nøgle afledt af installationens `TOTP_ENCRYPT_KEY`. Behold denne installationsnøgle sammen med databasen ved flytning. Hvis nøglen skiftes, skal brugerne gemme deres Mailcow-adgangskoder igen. Det almindelige SMTP til Sharedrive-notifikationer er adskilt fra brugerkontiene.

## Kør på testserveren

`docker-compose.mailcow.yml` er et valgfrit tillæg, der lader Go og Node dele loopback uden at publicere en ekstra port. Angiv `SHAREDRIVE_MAILCOW_TOKEN` i testmiljøet, og læg tillægget oven på testserverens eksisterende Compose-filer. Det ændrer ikke, hvilket Sharedrive-image testserveren bruger. Teststacken bør pege på GitLab-imaget med det godkendte commits korte hash, så den testede version kan identificeres i Sharedrives build-info.

I repoets nuværende pipeline publicerer et push til standardbranchen både commit-tagget og GitLab-registryets `latest`. Tjek, hvad der bruger dette tag, før et testpush godkendes. Publicering til GitHub er et separat manuelt job. Pipelinen starter ikke selv Node-tillægget. Det skal tilføjes til teststacken og have samme token og port som Go-processen.

For eksempel ved lokal Docker-udvikling:

```sh
docker compose -f docker-compose.dev.yml -f docker-compose.mailcow.yml up -d --build
```

## Kilderevision

[src/brogaard/mailClient.ts](src/brogaard/mailClient.ts) stammer fra [Brogaard Suite, revision e0f4c8a](https://github.com/mrbridgefarm/Brogaard-Suite/blob/e0f4c8a1847138114d6651d685bec8ef960d97d9/backend/src/services/mailClient.ts). Forbindelsesprøven genbruger klientens IMAP-mappeopslag. Sharedrives lokale ændring sætter Sharedrive som klientnavn, bevarer serverens TLS-navn ved fastlåst IP og lukker inaktive eller fejlramte IMAP-forbindelser. Ved en upstream-opdatering skal denne ændring bevares eller dækkes af upstream. SMTP-godkendelse og de læsebaserede SOGo-prøver ligger i Sharedrives eget lag. Brogaards kalender- og adressebogsklienter kan importeres særskilt, når tjenesterne skal læse og skrive indhold.
