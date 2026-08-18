# Implementer Sharedrive Rooms

Status: Phase 0-5 er implementeret og brugertestet. Phase 6 er implementeret og accepteret til videre arbejde efter bruger-test af møde, tale og skærmdeling. Phase 7 er i gang med Rooms backup/restore, hardening og dokumentation.

## Aktuel fasestatus

- **Phase 0-4:** Implementeret. Rooms omfatter permanente Rooms, medlemsroller, live chat, reaktioner, filer/Notes, invitationer, link-gaester, Rooms-administration, ulaeste beskeder samt baade integreret hoved-PWA-navigation og en selvstaendig Rooms-PWA.
- **Phase 5:** Implementeret og brugertestet. Self-hosted LiveKit voice har Room-bundne 15-minutters media-tokens, join/leave, mute/unmute, deltagere, aktiv taler, reconnect-status og fejlhaandtering. Voice aktiveres eksplicit af admin i Rooms-indstillingerne. Kamera forbliver blokeret; LiveKit-data bruges kun til det interne signal ved skift af skærmdeling. Gæster kan kun deltage, naar baade Rooms Voice og invitationens `can_voice` er aktiveret. Lyd er testet på mobil og PC-browser.
- **Phase 6:** Implementeret og accepteret til videre arbejde. Skærmdeling bygger oven på LiveKit med Teams-lignende mødehandlinger, start/stop/skift af skærm eller fane, remote rendering, stor popup-visning og mindst privilegerede media-tokens. Rumoversigten og Room-siden viser privat `Tale i gang`/mødestatus uden at eksponere samtaleindhold. Kamera forbliver blokeret.
- **Phase 7:** I gang. Admin-backupformatet er udvidet med valgfri Rooms-serialisering og sikker restore: chat-/medlemshistorik bevares, mens gæstelinks og gæstesessioner altid gendannes tilbagekaldt. Ældre backupper uden Rooms blokeres sikkert, hvis target allerede har Rooms. Rooms/LiveKit-dokumentation er tilføjet; afsluttende hardening og bruger-test mangler.
- **Phase 8:** Ikke startet. Fuld regression og sammenligning med baseline afslutter projektet.

Denne fil er den kanoniske arbejdsbeskrivelse for Sharedrive Rooms. Repositoryets faktiske kode er altid source of truth. Arbejdet udføres fasevist, uden automatiske commits eller versionsbump.

## Hovedregel

Eksisterende Sharedrive-funktionalitet maa ikke oedelægges, erstattes eller unoedvendigt refaktoreres. Rooms bygges additivt oven paa den eksisterende arkitektur.

- Genbrug eksisterende services, datamodeller, authentication, sessions, users, groups, permissions, sharing, storage, uploads, TUS, audit, rate limiting, frontend patterns og UI-komponenter.
- Introducer ikke parallelle systemer for filer, storage, users, permissions eller authentication.
- Rediger aldrig eksisterende migrationsfiler. Opret kun nye Goose migrations.
- Bevar eksisterende API-kontrakter, medmindre en isoleret og bagudkompatibel udvidelse er noedvendig.
- Files, Notes, Shares, WebDAV, OnlyOffice, preview, backups, PWA, admin og authentication skal fungere som foer.
- Lav ikke generelle refactors eller cleanup som del af Rooms.
- Vaelg altid den mindst invasive integration.
- Stop og dokumenter design/migration foer fundamentale aendringer af file IDs, blobs, ownership, authentication, permission semantics, Notes authorization, WebDAV, OnlyOffice URLs, backups, gamle migrations eller generelle security headers.

## Ufravigelig regel: sikker opgradering af eksisterende installationer

Sharedrive-testserveren er i aktiv brug og behandles som produktion. Nye Rooms-funktioner skal derfor altid kunne rulles ud som en in-place opgradering:

- Ingen ny installation, sletning, nulstilling eller udskiftning af PostgreSQL-, Redis-, fil-, Notes- eller backup-data.
- Eksisterende container-navne, mounts, netværk, miljøvariabler og database bevares bagudkompatibelt.
- Nye afhængigheder, som LiveKit, leveres som valgfrie søster-services. De må aldrig forhindre eksisterende Files, Notes, chat eller login i at starte, hvis de ikke er konfigureret eller er nede.
- Feature-aktivering sker først efter deploy og funktionel test; en tom eller manglende LiveKit-konfiguration skal give en forståelig voice-fejl, ikke ændre eller blokere Sharedrive.
- Før enhver migration eller deployment med data-/infrastrukturændring tages og verificeres en eksisterende backup. Rollback skal kunne ske ved at gå tilbage til forrige Sharedrive-image uden at gendanne data.
- Nye standardinstallationer må gerne bruge den samlede Compose-stack, men eksisterende Unraid-installationer migreres trinvist og uden at genskabe containere eller data.

## Produktvision og scope

Sharedrive Rooms er et permanent, self-hosted samarbejdsworkspace omkring eksisterende Sharedrive-ressourcer:

```text
Room
|-- Conversation
|-- Files
|-- Notes / shared resources
|-- Voice
|-- Screen sharing
`-- Members
```

Et Sharedrive Room er permanent PostgreSQL-data. En LiveKit media-session er midlertidig og et separat objekt.

Et Room har en kopierbar URL, fx `/rooms/project-alpha`. Eksterne gaester bruger `/rooms/join/<secure-token>`, hvorefter token udveksles og fjernes fra URL'en. UI skal mindst have `Copy room link` og kan have `Copy invitation text`.

Foelgende er eksplicit uden for scope: mailklient, kalender, Outlook/Google/Exchange-integration, meeting scheduling, SMTP meeting invites, Graph/OAuth/CalDAV/ICS management, telefoni/SIP, bots, whiteboard, breakout rooms, video recording og kamera/video i foerste version.

## Sources of truth

```text
Users       -> existing Sharedrive users
Groups      -> existing Sharedrive groups
Files       -> existing Sharedrive files
Storage     -> existing Sharedrive storage
Permissions -> existing Sharedrive authorization/share system
Notes       -> existing Sharedrive Notes
Audit       -> existing Sharedrive audit
Rooms       -> new Rooms module in PostgreSQL
Chat        -> new Rooms chat data in PostgreSQL
Ephemeral   -> existing Redis, namespaced for Rooms
Media       -> optional self-hosted LiveKit
```

En Room-vedhaeftning er altid en reference til et eksisterende Sharedrive `file_id` eller `note_id`. Rooms maa ikke have attachment blobs eller kopier af Notes-indhold/filmetadata som source of truth.

## Phase 0 - repository audit og baseline

Foer produktionskode:

- [x] Kortlaeg backendstruktur og `/api/v1` routing.
- [x] Kortlaeg authentication/session middleware og Origin/CSRF-kontroller.
- [x] Kortlaeg users, groups, group membership og admin-policy.
- [x] Kortlaeg file/folder models, ownership og delete-user-flow.
- [x] Kortlaeg central file authorization, shares, group shares og re-share.
- [x] Kortlaeg multipart upload, TUS/resume, quota, checksum, metadata, storage og audit.
- [x] Kortlaeg preview, OnlyOffice, trash og WebDAV-integration.
- [x] Kortlaeg Notes authorization, deling og guest token/session-flow.
- [x] Kortlaeg Redis, rate limiting, audit og logger conventions.
- [x] Kortlaeg Goose migrations, backup og restore.
- [x] Kortlaeg security headers, Permissions-Policy, CSP og CORS.
- [x] Kortlaeg Docker/Compose og environment configuration.
- [x] Kortlaeg frontend router, API-klient, navigation, i18n, UI patterns og responsive layout.
- [x] Find eksisterende WebSocket dependency/patterns, eller dokumenter at der ikke er nogen.
- [x] Kortlaeg tests og build/lint/typecheck scripts.
- [x] Koer baseline backend tests.
- [x] Koer baseline frontend tests, typecheck, lint og production build.
- [x] Noter alle eksisterende fejl separat fra Rooms-regressioner.
- [x] Skriv Rooms architecture document, datamodel og API-kontrakt foer implementering.

### Fundne repository-kommandoer

- Backend tests: `cd backend && go test ./... -race -timeout 60s`
- Backend build: `cd backend && go build -o bin/server ./cmd/server`
- Backend lint: `cd backend && golangci-lint run ./...` (kraever lokal `golangci-lint`)
- Frontend tests: `cd frontend && npm run test:coverage`
- Frontend typecheck: `cd frontend && npm run type-check`
- Frontend lint: `cd frontend && npm run lint`
- Frontend production build: `cd frontend && npm run build`

### Baseline-resultater

- Editorens samlede test-runner: 74 tests bestaaet, 0 fejlet.
- Backend `go test ./...`: groen for alle pakker.
- Backend `go build -o bin/server ./cmd/server`: groen.
- Backend repositorykommando med `-race`: kan ikke koere i det aktuelle Windows-miljoe, fordi Go race detector kraever CGO.
- Backend `golangci-lint run ./...`: kan ikke koere, fordi `golangci-lint` ikke er installeret lokalt.
- Frontend `npm run type-check`: groen.
- Frontend `npm run lint`: groen uden warnings.
- Frontend `npm run build`: groen. Eksisterende warnings: `api.ts` er baade statisk og dynamisk importeret, og enkelte chunks er over 500 kB.
- Frontend `npm run test:coverage`: 18 tests bestaar med 100% coverage for de to utility-filer, men kommandoen fejler, fordi fork-workeren til `UploadZone.test.tsx` ikke svarer inden 60 sekunder.
- Isoleret `UploadZone.test.tsx`: 2 tests bestaar; processen tager ca. 68 sekunder, heraf ca. 48 sekunder til testmiljoe. Det bekraefter en baseline worker-timeout, ikke en test assertion-fejl.
- `npm ci` fra eksisterende lockfil rapporterer 12 dependency findings: 2 low, 1 moderate og 9 high. Dependency-opgraderinger er ikke blandet ind i Rooms.

## Verificeret repository-audit

### Backend og routing

- `backend/cmd/server/main.go` initialiserer config, PostgreSQL, Redis og modul-handlers.
- `backend/internal/server/server.go` bygger en chi-router. Authenticated routes bruger eksisterende `SessionMiddleware` og `RequireAuth`; admin routes tilfoejer `RequireAdmin`.
- Rooms skal wires ind som et nyt handler/service-modul i den authenticated `/api/v1`-gruppe. Guest exchange/endpoints placeres eksplicit uden for user-session-gruppen og bruger egen guest-session validation.
- Global JSON body limit er 4 MB. Upload/TUS har separate limits og maa fortsat bruge deres eksisterende paths.
- Request loggeren redigerer Notes raw invite tokens. Rooms invite paths skal ind i samme redaction-pattern fra foerste guest-fase.

### Authentication og security headers

- User identity kommer fra server-valideret session context; Rooms maa aldrig acceptere client-supplied user ID.
- CORS bruger konfigurerede origins og credentials. Rooms WebSocket skal lave en selvstaendig strict Origin-check; buddy-tunnellens `InsecureSkipVerify` er ikke et passende Rooms-pattern.
- CSP tillader aktuelt brede `ws:` og `wss:` connect sources. LiveKit-fasen skal stramme/validere den konkrete origin i stedet for at stole paa denne bredde.
- `Permissions-Policy` blokerer aktuelt `camera`, `microphone` og `display-capture`. Kamera skal forblive `()`. Microphone/display-capture aabnes foerst i media-fasen og mindst muligt.

### Users, groups og membership

- `groups` og `group_members` findes allerede; group shares beregner adgang dynamisk via `group_members`, saa removal kan fjerne Room-baseret adgang uden at beroere andre shares.
- Groups har ikke managed/hidden/type-felter. Alle group admin-endpoints kan i dag liste, aendre, slette og mutere membership.
- En Room-managed group er derfor kun sikker efter en additiv migration og server-side guards paa samtlige admin group mutations. UI-filtrering alene er ikke tilstraekkelig.
- `room_members` er Rooms source of truth for rolle og membership. `group_members` er en afledt authorization-adapter, som opdateres i samme databasetransaktion. Room-kode maa ikke bruge eksisterende admin HTTP-handlers internt.
- Room create/member add/member remove/archive skal have repository/service-metoder, der atomisk holder Room membership, managed group og audit-intention sammen.

### Files, permissions og sharing

- Files er UUID-baserede records med immutable `owner_id`, parent relation, storage path, MIME, size, checksum og soft-delete timestamp.
- Existing access queries genbruger active/non-expired shares paa resource eller ancestors og dynamisk user/group membership.
- `AuthorizeParentWrite` accepterer ejer eller en existing `can_edit` share. De konkrete View/Edit/Delete/Reshare checks er i dag fordelt paa flere handler/service queries; der findes ikke en fuld central authorization service endnu.
- `POST /api/v1/shares` er ikke en genbrugelig Rooms service. Dens file lookup accepterer ejer eller direkte barn af en ejerfolder og haandhaever ikke existing `can_reshare` for en delt fil.
- Foer Phase 3 skal eksisterende permission-SQL samles bag en lille central authorization/share-adapter med fokuserede regressionstests. Det er en isoleret konsolidering, ikke et nyt permission-system.
- Room file cards skal slaa filer op gennem denne adapter og maa ikke eksponere metadata ved manglende adgang.

### Upload, storage og quota

- Multipart upload og TUS ender som normale `files` records og bruger eksisterende storage, SHA-256, quota, MIME/metadata og audit/IO tracking.
- TUS bruger eksisterende `tusd` og et server-udstedt upload token. Rooms maa tilfoeje kontekst til det eksisterende flow frem for et attachment endpoint med egen storage.
- Storage er UUID-sharded og kan vaere AES-256-GCM krypteret uden at aendre file record semantics.
- Phase 3 skal bevise med integrationstest, at attach existing aldrig skriver blob, og at Room upload skriver praecis én normal blob/file record.

### Kritisk ownership stop-regel

- Admin user deletion koerer eksplicit `DELETE FROM files WHERE owner_id = $1` og sletter derefter brugeren.
- En fil uploadet til et Room med uploader som owner kan derfor forsvinde ved user deletion, selv om Room stadig eksisterer.
- Phase 1 og 2 aendrer ikke file ownership. Phase 3 maa ikke love Room-owned permanence, foer et separat backward-compatible design for user deletion, quota, WebDAV, OnlyOffice, preview, trash og backup er godkendt.
- Midlertidig MVP kan kun bruge existing user ownership + Room sharing, og UI/docs skal beskrive dette. En skjult service account eller automatisk owner reassignment indfoeres ikke uden separat design, fordi begge aendrer quota/ownership semantics.

### Notes guest pattern

- Notes genererer 256-bit random tokens og gemmer SHA-256 hashes for invite og guest session.
- Accept opretter kortlivet `HttpOnly`, `SameSite=Lax` cookie med `Secure` efter deployment config.
- Mutations validerer Origin/Referer; sessions genvalideres mod share expiry/revoke og kan revokes server-side.
- Rooms genbruger sikkerhedsfilosofi og primitives/patterns, men bruger separat cookie/path/table og tillader aldrig et Notes authorization bypass.

### Redis, WebSocket og rate limiting

- Existing Redis limiter er et sliding-window sorted-set/Lua pattern med namespaced prefixes og kan genbruges til Room handlinger.
- `nhooyr.io/websocket` findes allerede, men kun buddy backup tunnel bruger den. Dens binary tunnel og skipped Origin-check maa ikke kopieres til Rooms chat.
- Rooms skal have egen authenticated JSON protocol, message limit, per-identity/event limiter, strict Origin, ping/pong og clean close. PostgreSQL er message source of truth.

### Audit, backup og migrations

- Audit loggeren er async og metadata-baseret; nye Room event constants kan tilfoejes additivt uden message body.
- Goose migrations er nummererede SQL-filer. Kun en ny migration efter repositoryets aktuelle sidste migration oprettes.
- Backup har eksplicit serialisering og restore for Files og Notes; Rooms kommer ikke automatisk med og kraever egne archive records/query/restore paths i hardening-fasen.
- Room invite hashes/config kan medtages; raw tokens og guest sessions maa ikke medtages.

### Frontend

- Appen bruger React, Vite, TanStack Router/Query, en same-origin `api` client med credentials og `sonner` toasts.
- `Sidebar` har statiske main/admin nav arrays og rollebaseret admin-sektion. Rooms navigation skal feature-flagges og integreres her.
- Routes er filbaserede, og `routeTree.gen.ts` er genereret output. Room routes oprettes efter eksisterende `_auth.*` pattern.
- I18n er en typed dansk/engelsk dictionary i `frontend/src/lib/i18n.tsx`; alle Rooms strings tilfoejes der.
- Files har eksisterende UploadZone, folder picker, preview, OnlyOffice og share dialogs, som Phase 3 skal genbruge eller udskille smaa genbrugelige dele fra uden generel refactor.
- Notes har eksisterende editor/share/guest patterns. PWA har separate site/Notes manifests og service worker. Rooms skal både være en integreret del af hoved-Sharedrive PWA og have sin egen installerbare Rooms-PWA med separat manifest, start-URL og relevant Room-navigation. Den selvstændige PWA skal fortsat bruge samme Sharedrive authentication, API, permissions og data; den er ikke en parallel application eller data-store.

## Genbrugsmatrix

| Rooms-behov | Eksisterende ejer | Beslutning |
| --- | --- | --- |
| User identity/session | `internal/auth`, `internal/middleware` | Genbrug context identity og auth middleware direkte. |
| Room file access | `internal/files`, `internal/shares`, `shares`, `group_members` | Byg en lille central adapter over eksisterende regler; ingen kopieret Rooms-SQL. |
| Room membership til file shares | `groups`, `group_members` | Managed group som afledt, transaktionelt synkroniseret adapter. |
| Upload/TUS | file handler/service, tusd, quota/storage | Genbrug samme pipeline; ingen Room blob storage. |
| Preview/editor/download | Files preview, OnlyOffice, download routes | Resource card linker til eksisterende autoriserede flows. |
| Note links | Notes handler/service | Reference-only; Notes afgør altid adgang. |
| Guest security | Notes sharing patterns | Genbrug token/session/origin-principper med Room-specifik state. |
| Abuse controls | Redis rate limiter | Nye namespaced Room keys og passende limits. |
| Realtime transport | `nhooyr.io/websocket` dependency | Ny Rooms hub/protocol; buddy tunnel genbruges ikke som arkitektur. |
| Audit | async audit logger | Nye event types med IDs/roles/permissions, ikke message body. |
| Backup | backup archive/service/restore | Eksplicit Rooms serialization/restore i Phase 7. |
| UI data | API client + TanStack Query | Eksisterende query/mutation/invalidation patterns. |
| UI navigation/i18n | Sidebar + i18n dictionary | Additive feature-flagged nav og DA/EN keys. |

## Phase 1 arkitekturbeslutning

Phase 1 holdes fri af files/chat/guest/media og beviser kun Room core.

- Ny `rooms`-tabel med UUID, name, unique slug, created_by, timestamps og archived_at.
- Ny `room_members`-tabel med `(room_id, user_id)` uniqueness, rolle-check og `added_by`.
- Additive managed/type-felter paa `groups`, eller en separat entydig Room-to-group relation, efter endelig migrationsgennemgang. Eksisterende almindelige groups beholder default-adfaerd.
- Room create opretter Room, owner membership, managed group og derived group membership i én transaktion.
- Member add/remove muterer `room_members` og derived `group_members` i én transaktion.
- Owner kan ikke fjernes uden eksplicit ownership transfer, som ikke er del af foerste Phase 1-slice.
- Archive revokerer senere invites/media joins, men sletter aldrig files/Notes/group. Phase 1 markerer kun Room archived og goer mutationer readonly efter central policy.
- API starter med list/create/get/patch/archive og list/add/remove members. DELETE bruges ikke til destruktiv Room deletion.
- Sharedrive-admin har en eksplicit, platform-wide moderationsret til at slette alle Room-chatbeskeder. Adminstatus er fortsat ikke implicit membership eller adgang til Room-delte filer og Notes.

## Rooms systemindstillinger

Rooms konfigureres af administrator under `Admin -> Indstillinger -> Rooms`, ikke med Docker- eller environment-variabler. Indstillingerne gemmes i eksisterende `system_settings` og auditeres som almindelige adminindstillingsændringer.

Foerste user-test skal have disse standarder:

- **Aktivér Rooms:** slået fra som standard; aktivering viser Rooms-navigation og åbner Rooms API for autentificerede brugere.
- **Maks. tegn pr. chatbesked:** `4.000`. Grænsen gælder én besked, aldrig hele Roomets chat.
- **Maks. Rooms-data i alt:** `500 MB`. Tæller kun Rooms-ejet PostgreSQL-data som chatbeskeder, replies, reactions og read-state.
- **Besked-retention:** `0` dage betyder permanent opbevaring, medmindre lagergrænsen kræver oprydning.
- **Oprydning ved lagergrænse:** slet ældste chatbeskeder gradvist med en 10 % fri buffer. Admin ser valgt regel, aktuelt forbrug og seneste oprydning.
- **Inkludér Rooms i backup:** slået til som standard, når Phase 7 backup/restore for Rooms implementeres.

Room-dataregler må aldrig automatisk slette, ændre eller tælle eksisterende Sharedrive Files, Notes, filblobs, media eller andre Sharedrive-ressourcer. Filer og Notes er fortsat kun referencer med deres egne permissions og retention-regler.

Chat-retention, byteberegning og automatisk oprydning implementeres først med Phase 2-chatten. Indstillingerne kan vises og ændres i Rooms-fanen før da, men UI skal tydeligt markere indstillinger, der endnu ikke har aktiv effekt.
## Faseplan

### Phase 1 - Room core

- Nye additive Goose migrations.
- Room CRUD, archive/soft-delete og simple roller: `owner`, `moderator`, `member`.
- Central Room authorization og member management.
- Eksisterende admin-policy afklares og testes.
- Audit for security-relevante Room-actions.
- Integreret Rooms-navigation, Room-liste og responsiv Room-side.
- Alle UI-strenge i eksisterende i18n med mindst dansk og engelsk.

### Phase 2 - Chat

- PostgreSQL-persistente plain-text messages med escaped rendering.
- Cursor/keyset pagination; aldrig `SELECT all messages ever`.
- Reply, edit/delete og timestamps. Afsenderen kan redigere/slette egen besked; Room owner/moderator kan slette alle beskeder i det paagaeldende Room; Sharedrive-admin kan slette alle Room-beskeder globalt. Ingen kan redigere andres beskeder.
- Reactions og emojis gemmes som Unicode-tegn, ikke som uploadede billedfiler. UI har en soegbar, Messenger-lignende emoji-vaelger med emner for smileys, personer, dyr, mad, aktiviteter, rejser, ting, symboler, flag og ekstra Unicode. Vaelgeren ligger i en viewport-aware portal, saa den aldrig klippes af chat-containeren og kan aabne over eller under knappen. Den bruger den lokalt bundne og versionsfastlaaste OpenMoji-pakke (CC BY-SA 4.0) med synlig attribution og uden runtime-CDN. Brugerens 10 mest anvendte emojis vises foerst og gemmes lokalt pr. bruger og browser/enhed. Buildet kontrollerer informativt for en nyere stabil npm-release; opdatering sker manuelt efter review og aendrer aldrig produktionen automatisk.
- Permanent read state per Room/bruger, ikke en raekke per besked. Egne og slettede beskeder samt historik fra foer brugerens aktuelle medlemskab taeller ikke som ulaeste. Room-oversigten viser antal ulaeste pr. Room, Rooms-punktet i sidemenuen viser det samlede antal, og browserfanens titel markerer nye beskeder paa tvaers af Sharedrive. Status opdateres via Roomets live-events og en kort periodisk synkronisering, saa flere samtidige brugere har hver deres korrekte state.
- Realtime WebSocket med server-afledt identity, Room-access, Origin-check, size limit, rate limits, ping/pong og clean disconnect.
- Redis kun til namespaced ephemeral presence, typing og event distribution.
- Typing throttles og gemmes aldrig permanent.

### Phase 3 - Files og Notes resources

- Attach existing file uden kopi; samme file ID, blob, checksum, metadata og editor/preview.
- Backend verificerer baade adgang og eksisterende re-share-ret.
- Room-upload bruger normal multipart/TUS pipeline, quota, storage, checksum, MIME, audit og preview. Uploadede og tilknyttede resources vises som tidsordnede elementer i chatten; lukning af en fil-preview vender tilbage til samme Room.
- Fil- og Note-vaelgeren aabnes fra en attachment-knap ved chatfeltet i en viewport-aware portal; Roomet viser ikke en separat resourceliste under chatten. Preview-understoettede billeder vises som kompakte thumbnails direkte i tidslinjen, mens andre filer og Notes vises som neutrale kompakte kort.
- Resource cards slaar autoriseret metadata op ved rendering og batcher lookups for at undgaa N+1.
- Manglende/slettet/ikke-autoriseret resource laekker ikke metadata.
- Sletning af message/resource relation sletter aldrig filen eller Noten.
- Notes linkes med eksisterende note-ID. Eksisterende Note authorization omgaas aldrig; `Access required` er acceptabelt.
- Foerste version bruger eksisterende user ownership + Room sharing, medmindre audit beviser at workspace ownership er sikkert additivt.

### Phase 4 - Guest Rooms

- Rooms er tilgaengelig i hoved-Sharedrive PWA og som selvstaendig installerbar Rooms-PWA via `rooms.webmanifest`, med `/rooms/` som start-URL og scope.
- Rooms-brugerflader har dansk/engelsk i18n og datoformatering, der foelger brugerens valgte sprog.
- Kryptografisk random invite token; kun hash gemmes i databasen.
- Expiry, revoke, flere links hvis modellen forbliver simpel; raw token vises kun ved oprettelse.
- Token exchange til kortlivet, revocable, server-valideret HttpOnly/Secure/SameSite guest session.
- Raw token fjernes fra URL og maa ikke logges eller ligge i backup.
- Den samlede Tilfoej person-dialog lader owner/moderator vaelge medlem eller guest; owner kan ogsaa vaelge moderator. En eksisterende Sharedrive-bruger tilknyttes direkte. En ukendt medlem/moderator-mail faar en begraenset Rooms-only konto-invitation, mens en guest faar et tidsbegraenset link og eksplicitte permissions. Den konfigurerede SMTP-server sender en Sharedrive-velkomst via `APP_BASE_URL`; hvis mail fejler, vises og kopieres linket som fallback.
- Admin -> Brugere -> Rooms viser Sharedrive+Rooms-konti, Rooms-only konti, afventende kontoinvitationer og aktive link-gaester. Admin kan deaktivere en kontos Rooms-adgang server-side.
- Owner/moderator styrer Room-permissions som chat, voice og screen share.
- File access afgøres fortsat af eksisterende file authorization.
- Guest upload er deaktiveret som standard og kraever baade global admin-aktivering og en eksplicit permission paa invitationen styret af Room owner/moderator.
- Tilladt guest upload gaar gennem normal multipart/TUS-pipeline med MIME-, checksum-, quota-, storage- og rate-limit-kontrol og auditeres med guest/Room metadata.
- Guest-uploadede filer oprettes som normale Sharedrive-filer ejet af Room-ejeren i en automatisk, systemstyret `Rooms/<room-slug>/Guest uploads`-mappe, der er synlig i ejerens Files. Roomet gemmer kun filreferencen.
- Standardgraenser er 25 MB pr. fil, 10 filer pr. guest session og 100 guest uploads pr. Room pr. rullende 24 timer. Admin kan saette lavere/hoejere graenser i Rooms-indstillinger; eksisterende konto-/uploadkvoter og den strengeste graense vinder altid.
- Owner og moderator kan se aktive gaestesessioner og tilbagekalde en enkelt session straks uden at paavirke Roomets oevrige gaester.
- Chatlinjen samler fil/billede, emoji, tekst og send. Voice og skaermdeling tilfoejes samme sted i deres respektive faser.
- Session revoke, member removal, invite revoke og fjernelse af Room-referencen sletter aldrig den normale Sharedrive-fil. Permanent sletning bruger fortsat Files/trash-flowet.

### Phase 5 - optional LiveKit voice

- LiveKit er separat, self-hosted media layer og aldrig embedded i Go-binary.
- Rooms/chat/files/members virker uden LiveKit og mens LiveKit er nede.
- Backend genererer short-lived token efter Room/member/guest/voice authorization.
- `LIVEKIT_API_SECRET` sendes aldrig til frontend eller logs.
- Participant identity og deterministisk media room name genereres server-side.
- Token bindes til praecis Room og begraenser publish permissions.
- Join, leave, mute/unmute, participants, speaker/connection state, reconnect og klare fejl.
- Microphone request sker kun efter eksplicit `Join voice`.
- Kamera anmodes aldrig og er disabled i UI, token grants og Permissions-Policy.

### Phase 6 - screen sharing

- Rumoversigten viser `Tale i gang` pr. Room, når LiveKit har mindst én forbundet deltager. Status hentes server-side og viser hverken deltagernavne, lyd eller andet samtaleindhold.
- Eksplicit `Share screen` bruger LiveKits officielle screen-share API.
- Start/stop, remote rendering, sharer indicator, cleanup og browser-stop haandteres.
- Microphone fortsaetter efter screen-share stop.
- Server/media grants haandhaever `can_share_screen`; skjult frontendknap er ikke security.
- Feature detection giver brugbar mobiloplevelse uden umulige actions.

### Phase 7 - hardening og deployment

- Audit, backup/restore, rate limiting, security review, responsive UI, accessibility, i18n og docs.
- Route-/context-specifik Permissions-Policy foretraekkes; ellers mindst brede sikre SPA-policy.
- `camera=()` bevares; microphone/display-capture aabnes mindst muligt.
- CSP udvides kun med valideret LiveKit origin i relevante directives.
- Existing HSTS/CORS/CSP/security headers svaekkes ikke generelt.
- Optional Compose profile eller separat compose-fil; eksisterende deployment virker uden media config.
- Dokumenter LiveKit DNS, TLS/HTTPS/WSS, ICE UDP/TCP fallback, TURN UDP/TLS, firewall, NAT/external IP og Cloudflare-begrænsninger efter aktuelle officielle docs.
- Ingen telemetry, hosted analytics eller SaaS-afhaengighed.

### Phase 8 - regression

Koer hele den eksisterende backend/frontend pipeline og sammenlign med Phase 0-baseline. Rooms-relaterede regressioner rettes; eksisterende baselinefejl registreres separat.

## Datamodel - designudgangspunkt

Den endelige model fastlaegges efter Phase 0 og eksisterende PostgreSQL conventions.

### `rooms`

- `id`, `name`, `slug`, `created_by`, `created_at`, `updated_at`, `archived_at`
- Kun noedvendige settings tilfoejes.

### `room_members`

- `room_id`, `user_id`, `role`, `joined_at`, `added_by`
- Unik membership og rollerne `owner`, `moderator`, `member`.

### `room_messages`

- `id`, `room_id`, `sender_user_id`, `sender_guest_session_id`, `body`, `reply_to_message_id`, `created_at`, `edited_at`, `deleted_at`
- Plain text med rimelige size limits.

### `room_message_resources`

- `id`, `message_id`, `resource_type`, `resource_id`, `created_at`
- Kun relationer til eksisterende resources; ingen snapshots/blobs.

### `room_reactions`

- `message_id`, user/guest identity, `emoji`, `created_at`
- Simpelt tilladt emoji-format og unik reaction per identity/message/emoji.

### `room_read_state`

- `room_id`, `user_id`, `last_read_message_id`, `updated_at`
- Lille permanent state, saa unread overlever restart.

### `room_invites`

- `id`, `room_id`, `token_hash`, `created_by`, permissions, `expires_at`, `revoked_at`, `created_at`
- Index paa `token_hash`; raw token gemmes aldrig.

### Indekser

Minimum analyseres for:

- messages `(room_id, created_at, id)` eller `(room_id, id)` til keyset pagination
- members `(room_id, user_id)` med uniqueness
- invites `token_hash`
- resource relations per message og resource
- read state per `(room_id, user_id)`

## Membership og eksisterende groups/shares

Foretrukken kandidat, kun hvis eksisterende modeller egner sig sikkert:

```text
Room -> system-managed room group -> existing group share -> Room members
```

En Room-group skal skjules eller tydeligt markeres som Room-managed og maa ikke kunne redigeres paa en maade, der skaber drift mellem Room og group membership.

Hvis group-modellen ikke egner sig, holdes membership separat, og en central authorization adapter kalder eksisterende share/file services. Eksisterende permission-logik maa aldrig kopieres ind i Rooms.

Naar et medlem fjernes, fjernes kun Room-baseret adgang. Ejerskab eller andre legitime user/group shares bevares gennem den centrale authorization-beregning.

## API-design - foreloebigt

Tilpasses repositoryets eksisterende `/api/v1` conventions efter audit:

```text
GET    /api/v1/rooms
POST   /api/v1/rooms
GET    /api/v1/rooms/{id}
PATCH  /api/v1/rooms/{id}
GET    /api/v1/rooms/{id}/members
POST   /api/v1/rooms/{id}/members
DELETE /api/v1/rooms/{id}/members/{userID}
GET    /api/v1/rooms/{id}/messages
POST   /api/v1/rooms/{id}/messages
PATCH  /api/v1/rooms/{id}/messages/{messageID}
DELETE /api/v1/rooms/{id}/messages/{messageID}
POST   /api/v1/rooms/{id}/files
DELETE /api/v1/rooms/{id}/files/{fileID}
POST   /api/v1/rooms/{id}/invites
DELETE /api/v1/rooms/{id}/invites/{inviteID}
POST   /api/v1/rooms/{id}/media-token
GET    /api/v1/rooms/{id}/ws
```

Alle operationer validerer identity, Room access og action/resource authorization server-side. Et kendt UUID er aldrig i sig selv adgang.

## Backend- og frontendstruktur

Foelg eksisterende patterns. Forventet additiv backend-modul er `backend/internal/rooms/` med modeller, service/repository, handler, websocket, guest og media opdelt efter faktisk lokal arkitektur. Business logic maa ikke placeres direkte i handlers.

Frontend integreres i eksisterende React/Vite/TanStack Router-app. Mulige smaa komponenter er RoomList, RoomHeader, RoomMembers, RoomConversation, Message, MessageComposer, ResourceCard, RoomFiles, VoiceControls, ScreenShareView og GuestJoin. Undgaa en gigantisk komponent og genbrug eksisterende dialogs, buttons, API/query, file picker/preview og i18n.

UI skal understøtte keyboard navigation, focus/dialog semantics, labels/aria, synlige mute/share states og status, der ikke kun kommunikeres med farve. Desktop og mobil skal vaere responsive.

## Feature flags og graceful degradation

Konkrete navne tilpasses eksisterende config conventions. Konceptuelt:

```text
ROOMS_ENABLED=true
ROOMS_MEDIA_ENABLED=true
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
```

- Rooms disabled: ingen navigation/endpoints, resten virker uændret.
- Rooms enabled/media disabled: chat, files og members virker; voice viser `not configured`.
- Rooms/media enabled: media token og LiveKit UI er aktivt.
- LiveKit offline: login, Files, Notes og Room chat virker; voice viser retry/forstaaelig fejl.

## Security og abuse controls

Server-side authorization kraeves for Room get/update/archive, messages, members, resources, uploads, invites, guest exchange, media join og screen share.

Rate limits genbruger eksisterende infrastruktur for create Room, guest join/invite validation/session creation, messages/edit/reactions, WebSocket connections/events, media tokens, uploads og invite creation. WebSocket maa ikke omgaa abuse controls.

WebSocket kraever authentication eller valid guest session, Room membership, strict Origin validation, max message size, rate limiting, ping/pong, clean disconnect og server-derived identity/permissions.

Security tests skal daekke:

- non-member Room/message fetch
- attach af kendt file UUID uden Room- eller re-share-ret
- guest media token til andet Room
- revoked guest session og expired/revoked invite
- forged WebSocket user ID, oversized message og rapid spam
- XSS i body og malicious filename rendering
- unauthorized resource metadata lookup
- LiveKit secret i frontend bundle
- raw invite token i logs/database/backup
- direct API authorization bypass

## Audit og backup

Audit security-relevante actions med metadata, ikke chatindhold:

```text
room.create
room.archive
room.member.add
room.member.remove
room.invite.create
room.invite.revoke
room.guest.join
room.file.share
room.file.upload
room.voice.join
room.voice.leave
room.screen_share.start
room.screen_share.stop
```

Typing/presence og andet meget stoejende ephemeral state auditeres ikke.

Backup/restore inkluderer Rooms, membership, messages, resource relations, reactions, relevant read state og invitation configuration. Det inkluderer ikke connections, typing, presence, raw guest session cookies/tokens, raw invite tokens eller LiveKit sessions/media state. Gæsteinvitationer og gæstesessioner gendannes alene for at bevare historiske relationer og markeres altid tilbagekaldt.

## Room lifecycle

Archive/soft-delete foretraekkes. Ved archive bliver Room readonly/skjult efter design, invites revokes og nye media joins stoppes. Filer og Notes slettes aldrig automatisk. Permanent deletion designes separat og defensivt.

At slette en message eller resource relation sletter aldrig den refererede fil/Note. File deletion bruger fortsat normalt trash/file-flow.

Room-uploadede filer forsvinder ikke, naar uploader forlader Room. Hvis delete-user-flow truer dette under eksisterende ownership, skal risiko og fremtidigt workspace ownership-design dokumenteres foer en fundamental aendring.

## Acceptance scenarios

### A - eksisterende Sharedrive

Login, 2FA, Files, multipart/TUS upload/resume, preview, download, rename, move, trash, file/group sharing, OnlyOffice, Notes/Notes guests, WebDAV, backups og admin fungerer som baseline.

### B - existing file into Room

Peter deler eksisterende `drawing.pdf` til Projekt Alpha. Anna faar kun Room-share permission. Der er stadig kun én file record/blob og samme ID. Redigering ses identisk fra Files og Room.

### C - upload fra Room

Upload bruger normal Sharedrive upload/storage/quota/audit og opretter normal file record. Message/resource refererer til file ID; ingen ekstra attachment blob findes.

### D - member removal

Room-baseret file access fjernes straks. Andre legitime shares eller ejerskab bevares.

### E - guest

Hashed/expiring invite valideres, udveksles til HttpOnly guest session og fjernes fra URL. Guest kan kun tilladte actions. Revoke fjerner adgang straks.

### F - voice

To autoriserede deltagere kan hoere hinanden; mute/unmute og leave virker. Kamera requestes aldrig, og participant state rydder korrekt.

### G - screen share

Eksplicit browser picker, remote view, stop/cleanup og fortsat microphone virker.

### H - LiveKit down

Login, Files, Notes og Room chat virker. Voice viser en forstaaelig fejl.

## Definition of done

- [ ] Existing Sharedrive, Files, Notes, Shares, authentication, WebDAV, OnlyOffice og backups er uændrede og brugbare.
- [ ] Rooms kan oprettes, aendres, arkiveres og have members med server-side authorization.
- [ ] Chat er realtime og persistent i PostgreSQL med pagination, unread, reply, edit/delete og reactions.
- [ ] Existing files kan deles uden kopi; Room-upload skaber normale Sharedrive-filer.
- [ ] Samme fil kan redigeres fra Files og Room gennem eksisterende permissions.
- [ ] Member removal fjerner kun Room-baseret access.
- [ ] Notes linkes uden duplikering eller authorization bypass.
- [ ] Guest link/session er hashed, short-lived, HttpOnly og revocable.
- [ ] Optional self-hosted LiveKit voice og screen share virker uden kamera.
- [ ] LiveKit secrets naar aldrig frontend; Sharedrive virker uden/ved nedetid af LiveKit.
- [ ] Room URL kan kopieres; ingen mail- eller kalenderfunktion er tilfoejet.
- [ ] Dansk/engelsk i18n, mobil, accessibility, security, rate limits, audit og backup er implementeret.
- [ ] Dokumentation for Rooms, privacy og LiveKit deployment/troubleshooting er skrevet.
- [ ] Backend tests, frontend tests/typecheck/lint/build og regressionspipeline er groen relativt til baseline.

## Arbejdsform

For hver fase:

1. Analyser kun den relevante eksisterende kode og identificer genbrugelige services.
2. Dokumenter datamodel/API/security-valg foer risikable integrationer.
3. Implementer den mindste additive aendring.
4. Skriv eller opdater fokuserede tests.
5. Koer fokuseret validering straks efter foerste substantielle edit.
6. Ret lokale regressions og koer samme check igen.
7. Koer lint/typecheck/build og bredere regression foer naeste fase.
8. Opsummer aendrede filer, hvorfor, tests og kendte begrænsninger.

Ingen automatiske commits. `VERSION` aendres ikke automatisk.
