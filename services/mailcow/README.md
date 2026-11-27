# Mail, Kalender og Kontakter

Den interne Node-tjeneste håndterer forbindelsesprøver og kald til Mailcow. Den lytter på `127.0.0.1`. Sharedrives Go-backend bruger den konto, der er tilknyttet den aktuelle Sharedrive-bruger.

## Kør lokalt

Kør `npm ci`, `npm test` og `npm start` fra `services/mailcow` med Node 22.22.0 eller nyere. Angiv følgende miljøvariabler før start. Go-processen og Node skal dele samme loopback-adresse og bruge samme token og port.

| Variabel | Værdi |
| --- | --- |
| `SHAREDRIVE_MAILCOW_TOKEN` | Lokal tjenestetoken med mindst 32 URL-sikre tegn |
| `SHAREDRIVE_MAILCOW_PORT` | Valgfri lokal port, standard 3025 |
| `SHAREDRIVE_MAILCOW_SMTP_PORT` | 465 med TLS som standard, eller 587 med STARTTLS |
| `MAILCOW_API_URL` | Valgfri HTTPS-adresse på den Mailcow-instans, hvis skjulte aliaser skal hentes |
| `MAILCOW_API_KEY` | Valgfri Mailcow-læsenøgle til aliaser på værten angivet i `MAILCOW_API_URL` |

`GET /healthz` viser, at tjenesten kører. Slå modulet til under Administration → Indstillinger → Mail i Sharedrive. Kør forbindelsesprøven fra **Mail** ved temavælgeren for testbrugere uden konto. For en allerede tilknyttet testkonto åbnes **Min Mailcow-konto** via tandhjulet i Mail. Brug hver postkasses egen Mailcow-vært og app-adgangskode. Go videresender prøven til den interne Node-tjeneste, som bruger et offentligt IPv4-resultat fra DNS og validerer TLS-certifikatet mod kontoens værtsnavn. Adgangskoden gemmes kun, når brugeren vælger at tilknytte kontoen.

Eksempel på svar:

```json
{"imap":"ok","smtp":"ok","caldav":"ok","carddav":"ok"}
```

Hver protokol returnerer `ok` eller `failed`. Prøven viser, om kontoen kan hente sin liste over IMAP-mapper, godkende sig til SMTP og finde en læsbar SOGo-kalender og adressebog. DAV-prøven kontrollerer både samlingstypen og status for egenskaben i DAV-svaret. SMTP-prøven sender ingen mail. DAV-prøven ændrer ingen kalenderaftaler eller kontakter. Se [arbejdsplanen](../../docs/sharedrive-mailcow-plan.md) for næste etape med adskilte testkonti og skrivning.

## Aktivér modulet

Standardimaget starter Node-tjenesten på loopback og lader funktionen være slået fra som standard. Gå til **Administration → Indstillinger → Mail**, og slå **Mail, Kalender og Kontakter** til. SMTP-fanen styrer stadig Sharedrives egne notifikationer.

Brugeren åbner **Mail** ved temavælgeren. Guiden beder om brugerens egen offentlige Mailcow-vært, e-mailadresse og app-adgangskode. Når alle fire protokoller er bekræftet og kontoen gemt, erstattes knappen af **Mail**, **Kalender** og **Kontakter** i brugermenuen. Hovedmenuen åbner Vue-arbejdsfladen i den valgte visning. Kontoen kan ændres eller afbrydes via tandhjulet i arbejdsfladen. Offentlige kalenderlinks åbner en skrivebeskyttet visning og kræver, at ejeren fortsat har samme konto tilknyttet. Kalenderlinks og indstillinger gemmes under `DATA_DIR`, som standard `/data/backups/.mailcow-suite` i Sharedrive-imaget.

Go krypterer adgangskoderne med en separat nøgle afledt af installationens `TOTP_ENCRYPT_KEY`. Behold denne installationsnøgle sammen med databasen ved flytning. Hvis nøglen skiftes, skal brugerne gemme deres Mailcow-adgangskoder igen.

## Valgfri separat tjeneste

Sæt kun `SHAREDRIVE_MAILCOW_TOKEN` eksplicit, hvis Go skal bruge en separat tjeneste. Brug i så fald samme token og port i begge processer. `docker-compose.mailcow.yml` kan bruges til det i udvikling.

## Kilderevision

[src/brogaard/mailClient.ts](src/brogaard/mailClient.ts) stammer fra [Brogaard Suite, revision e0f4c8a](https://github.com/mrbridgefarm/Brogaard-Suite/blob/e0f4c8a1847138114d6651d685bec8ef960d97d9/backend/src/services/mailClient.ts). Forbindelsesprøven genbruger klientens IMAP-mappeopslag. Sharedrives lokale ændring sætter Sharedrive som klientnavn, bevarer serverens TLS-navn ved fastlåst IP og lukker inaktive eller fejlramte IMAP-forbindelser. Ved en upstream-opdatering skal denne ændring bevares eller dækkes af upstream. SMTP-godkendelse og de læsebaserede SOGo-prøver ligger i Sharedrives eget lag. Vue-arbejdsfladen i `frontend/suite` og Mailcow-ruterne i `services/mailcow/suite` stammer fra [samme revision](https://github.com/mrbridgefarm/Brogaard-Suite/tree/e0f4c8a1847138114d6651d685bec8ef960d97d9). Sharedrive bygger Vue-arbejdsfladen som del af imaget. I lokal udvikling kan du bygge den med `npm ci --ignore-scripts` og `npm run build` fra `frontend/suite` og kopiere indholdet af `dist` til `frontend/public/mail/suite-ui`.
