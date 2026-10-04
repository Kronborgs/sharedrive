# Plan: Samlet adgangsstyring og chat-notifikationer

## Formål

Sharedrive skal have ét samlet sted, hvor administratoren kan se og ændre, hvad en bruger har adgang til.

Planen omfatter:

- Files
- Rooms
- Notes
- Musikafspilleren
- Gæster og invitationer
- Grupper
- E-mail- og Push-notifikationer fra Chat/Rooms

## 1. Produktadgang

| Produkt | Adgang |
| --- | --- |
| Files | Ingen, begrænset eller fuld |
| Rooms | Ingen, valgte Rooms eller alle Rooms |
| Notes | Ingen, egne/delte Notes eller fuld |
| Musikafspiller | Ingen, afspilning eller bibliotek/playlister |

Musikafspilleren er et separat produkt. Eksisterende afspilning, Media Session og lock-screen-funktionalitet skal bevares uændret.

Adgang opdeles i konto, produkt, ressource og funktion. Roller som admin, user og guest beskriver kontotypen, men skal ikke alene bestemme alle produktrettigheder.

## 2. Samlet brugeroversigt

Bruger-fanen skal vise navn, e-mail, rolle, status, sidste login, grupper, Files-, Rooms-, Notes- og Musik-adgang samt chat-notifikationer.

Et adgangspanel pr. bruger skal kunne:

- slå produkter til og fra
- vælge begrænset eller fuld adgang
- tilføje og fjerne grupper
- ændre rolle
- låse eller aktivere brugeren
- slå chat-notifikationer til og fra

Fjernelse af adgang skal bekræftes, når eksisterende medlemskaber eller delinger påvirkes.

## 3. Chat-notifikationer pr. bruger

Chat-notifikationer skal kunne aktiveres eller deaktiveres individuelt pr. bruger.

- Nye brugere får notifikationer slået til.
- Eksisterende brugere får notifikationer slået til via migration.
- Administratoren kan ændre indstillingen pr. bruger.
- Brugeren kan selv ændre indstillingen i egne indstillinger.

Når de er slået fra, må brugeren ikke modtage Room-chat-mails, private chat-mails eller Web Push fra Rooms. Chat, læsestatus og ulæste markeringer skal stadig fungere.

Lock-screen Push må fortsat ikke vise beskedtekst, afsender eller chatnavn.

Første indstilling:

```text
chat_notifications_enabled = true|false
```

Senere kan den opdeles i Room-chat, privat chat, e-mail, Push og digest-frekvens.

## 4. Chat-e-mail

Den eksisterende digest skal fortsat sende én samlet mail pr. bruger hver 12. time med beskeder, der stadig er ulæste.

Mailen kan indeholde chatnavn, afsender, tidspunkt, kort beskedudsnit og link. Aktuel læsestatus skal kontrolleres lige før afsendelse. Brugere med chat-notifikationer slået fra skal udelukkes fra digest-processen.

## 5. Rooms, invitationer og gæster

Rooms-fanen skal vise:

### Rooms-brugere

Bruger, kontotype, Rooms-adgang, antal Rooms, Room-roller og seneste aktivitet.

### Afventende invitationer

E-mail, Room, rolle, inviteret af, udløb og status. Handlinger: gensend, kopier link og tilbagekald.

### Gæster

Navn, identitet, Room, adgangsniveau, udløb og seneste aktivitet. Handlinger: se adgang, ændre adgang, forlænge og tilbagekalde.

De eksisterende backend-felter pending_invitations og guests skal genbruges.

## 6. Grupper

Grupper skal kunne bruges til genanvendelig deling, eksempelvis Familie, Venner, Arbejde og Bestyrelse.

Administrator skal kunne oprette, redigere og slette grupper samt se, tilføje og fjerne medlemmer.

Deling med en gruppe giver automatisk adgang til aktive medlemmer. Fjernelse fra gruppen fjerner adgangen via gruppen. Det skal være synligt, om adgang er direkte eller gruppebaseret.

Rooms-systemgrupper skal være beskyttede.

## 7. Files, Notes og Musik

Eksisterende direkte bruger- og gruppedeling skal bevares. Admin skal kunne se ressourcer, konkrete rettigheder, ejer, udløbsdato og adgangens kilde.

Musikafspilleren skal i første version kunne begrænses til ingen adgang, afspilning, egne playlister og fælles musikbibliotek. Senere kan playliste-deling og gruppeadgang tilføjes.

## 8. Database og backend

Produktadgang:

```text
user_product_access
- user_id
- product: files|rooms|notes|music
- access_level: none|limited|full
- created_at
- updated_at
```

Notifikationer:

```text
user_notification_preferences
- user_id
- chat_notifications_enabled
- room_email_enabled
- direct_email_enabled
- digest_interval
- updated_at
```

I første version er chat_notifications_enabled hovedkontakten. Backend skal altid håndhæve rettigheder; frontend-toggle er ikke sikkerhed alene.

## 9. Admin-API og audit

API'et skal understøtte samlet brugeradgang, produktadgang, ressourceadgang, grupper, Rooms-invitationer, gæstesessioner og notifikationsindstillinger.

Alle administrative ændringer skal i audit-loggen med administrator, bruger, gammel værdi, ny værdi, tidspunkt og berørte produkter eller ressourcer.

## 10. Frontend

Foreslåede komponenter:

- AdminUserAccessPanel
- AdminProductAccess
- AdminRoomsAccessPanel
- AdminGuestsPanel
- AdminGroupsPanel
- AdminNotificationSettings

De eksisterende admin-faner kan beholdes, men skal bruge ensartede statusser, handlinger og bekræftelser.

## 11. Implementeringsfaser

### Fase 1+§uçâçT Politik og datamodel

Fastlæg adgangsniveauer, opret migrationer, giv eksisterende brugere standardadgang, sæt chat-notifikationer til true, og beskyt sidste admin.

### Fase 2"éİyø§yÔ Samlet brugeradgang

Vis de fire produkter, implementér adgangspanel og hurtige toggles, og tilføj audit-log.

### Fase 3+§uçâçT Chat-notifikationer

Tilføj brugerens egen indstilling og admin-toggle. Opdater digest og Web Push til at respektere indstillingen.

### Fase 4"éİyø§yÔ Rooms, invitationer og gæster

Vis invitationer og gæstesessioner. Tilføj gensend, forlæng og tilbagekald.

### Fase 5+§uçâçT Grupper

Vis gruppemedlemmer, tilføj/fjern medlemmer og vis gruppebaseret adgang.

### Fase 6+§uçâçT Files og Notes-overblik

Vis ressourceadgang, direkte kontra gruppebaseret adgang, udløb og funktionsrettigheder.

### Fase 7"éİyø§yÔ Musikafspiller

Tilføj produktadgang, begræns funktioner og test afspilning, Media Session og lock-screen.

### Fase 8+§uçâçT Test og udrulning

Kør backend/API-tests, frontend typecheck/lint og migrationstest. Test admin, almindelig bruger, gæst og Rooms-only bruger. Verificér at notifikationer slået fra stopper mail og Push, at eksisterende brugere starter med notifikationer slået til, og at gruppeadgang og mobilafspiller fungerer.

## 12. Første MVP

1. Produktadgang til Files, Rooms, Notes og Musikafspilleren.
2. Samlet adgangspanel pr. bruger.
3. Rooms-brugere, invitationer og gæster i admin.
4. Gruppe-medlemsstyring.
5. Chat-notifikationer pr. bruger.
6. Notifikationer slået til som standard.
7. Admin-toggle til fra/til.
8. Bruger-toggle i egne indstillinger.
9. E-mail og Push respekterer indstillingen.
10. Audit-log for administrative adgangsændringer.

## 13. Relevante eksisterende områder

- frontend/src/routes/_auth.admin.users.index.tsx
- frontend/src/components/admin/AdminRoomsAccessPanel.tsx
- frontend/src/types/api.ts
- backend/internal/rooms/admin_access.go
- backend/internal/rooms/notifications.go
- backend/internal/rooms/push.go
- backend/internal/rooms/push_handler.go
- backend/internal/user/handler.go
- backend/internal/admin/handler.go
- backend/internal/server/server.go
- backend/internal/db/migrations/

Dette dokument er kun en plan. Backend og frontend er ikke ændret som en del af planen.

## Implementeringsstatus â€” september 2026

Planens fÃ¸rste administrative MVP er nu implementeret i kodebasen:

- Produktadgang for `files`, `rooms`, `notes` og `music` gemmes pr. bruger med niveauerne `none`, `limited` og `full`.
- Backend hÃ¥ndhÃ¦ver, at `none` blokerer produktets API-adgang. De eksisterende ressource-, dele- og Room-medlemskabskontroller gÃ¦lder fortsat.
- Admin â†’ Brugere viser produktadgang og chat-notifikationer pr. bruger med hurtige handlinger.
- Chat-notifikationer er slÃ¥et til som standard og kan slÃ¥s fra pr. bruger. E-mail-digest og Web Push respekterer indstillingen.
- Admin â†’ Rooms viser Rooms-konti, afventende invitationer og aktive gÃ¦ster. Invitationer og gÃ¦stesessioner kan tilbagekaldes.
- Grupper kan oprettes og medlemmer kan tilfÃ¸jes eller fjernes fra admin-brugerfladen.
- Admin GÃ¦ster har de relevante brugerhandlinger fra Admin Brugere: chat-notifikationer, gensend invitation, tvungen nulstilling af adgangskode, krav om eller fjernelse af TOTP 2FA, lÃ¥s/lÃ¥s op, promovering til almindelig bruger og sletning.
- Den mobile musikafspiller ligger fortsat Ã¸verst pÃ¥ siden, men under mobil-sidemenuen, sÃ¥ Notes og Mine filer kan bruges. Media Session og lock-screen-funktionalitet er ikke Ã¦ndret.

### Ikke fÃ¦rdigimplementeret endnu

- `limited` og `full` gemmes og vises, men alle ressource- og funktionsniveauer er endnu ikke opdelt fuldt ud pr. Files-, Notes-, Rooms- og Musik-ressource.
- Automatisk deling til grupper (for eksempel Familie eller Venner) er forberedt gennem medlemsstyring, men er endnu ikke aktiv som en samlet delingsmekanisme.
- GÃ¦steadministrationen omfatter nu notifikationer, invitationer, adgangskode, TOTP 2FA, lÃ¥sning, promovering og sletning fra admin-visningen.
- Backend-, frontend- og Sonar-kontroller indgÃ¥r i projektets almindelige validering.


## Current implementation: MFA and OnlyOffice

The current Sharedrive implementation also includes:

- Multiple active MFA methods per user and Guest, including multiple TOTP authenticators.
- MFA method status and last-use visibility, with protection against deleting the last active method.
- Administrator-controlled email MFA through SMTP and Redis, with expiry, one-time use, and invalidation when a new code is requested.
- Automatic inactivation of unused MFA methods after 30 days when another active method remains in use.
- OnlyOffice editing from Files, shared files, public shares, Rooms, direct conversations, and group chats.
- OnlyOffice formats: DOC, DOCX, DOCM, DOT, DOTX, RTF, ODT, OTT, XLS, XLSX, XLSM, XLSB, XLTX, CSV, ODS, OTS, PPT, PPTX, PPTM, POTX, ODP, and OTP.

Document access continues to use Sharedrive's existing file and sharing
permissions. A Chat or Rooms reference does not grant access to the file.