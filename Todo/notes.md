Du arbejder i dette repository:

https://github.com/Kronborgs/sharedrive

Din opgave er at implementere et komplet MVP-modul til noter og huskelister inspireret af Google Keep, men tilpasset Sharedrives eksisterende arkitektur, design, sikkerhedsmodel, SMTP-konfiguration, PWA og delingsfunktioner.

Løsningen skal være en integreret del af Sharedrive. Der må ikke oprettes en separat applikation, separat backend eller ny teknologistak.

==================================================
1. ARBEJDSMETODE
==================================================

Start ikke med at skrive kode med det samme.

Arbejd i denne rækkefølge:

1. Undersøg repository og beskriv den eksisterende arkitektur.
2. Identificer:
   - backendstruktur
   - routing
   - handlers/controllers
   - services
   - repositories
   - databaseadgang
   - migrationssystem
   - autentifikation
   - autorisation
   - CSRF-beskyttelse
   - rate limiting
   - audit logging
   - SMTP-service
   - e-mailtemplates
   - frontendrouting
   - navigation
   - designkomponenter
   - modaler
   - formularer
   - toast-beskeder
   - autosave
   - i18n
   - PWA-manifest
   - service worker
   - backup og restore
3. Find eksisterende kode til deling af filer og mapper.
4. Find eksisterende kode til offentlige links og invitationer.
5. Find eksisterende kode til e-mailinvitationer til personer uden konto.
6. Beskriv præcist hvilke eksisterende filer og komponenter der kan genbruges.
7. Lav en implementeringsplan opdelt i:
   - database
   - backend
   - frontend
   - gæsteadgang
   - SMTP
   - sikkerhed
   - PWA
   - i18n
   - tests
   - dokumentation
8. Vis datamodel og API-kontrakt før implementering.
9. Implementer i små, sammenhængende trin.
10. Kør formattering, linting, build og tests efter hver større fase.
11. Ret alle fejl inden næste fase.
12. Afslut med:
   - liste over ændrede filer
   - migrationer
   - nye endpoints
   - sikkerhedsvalg
   - testresultater
   - kendte begrænsninger

Genbrug eksisterende mønstre og komponenter. Omskriv ikke eksisterende funktionalitet uden en konkret grund. Bevar bagudkompatibilitet.

==================================================
2. FUNKTIONELT MÅL
==================================================

Tilføj et nyt hovedområde:

Dansk:
Noter

Engelsk:
Notes

Modulet skal fungere som en enkel, selvhostet Google Keep-lignende løsning.

MVP’en skal understøtte:

1. Almindelige tekstnoter.
2. Huskelister med afkrydsningsfelter.
3. Oprettelse af noter.
4. Redigering af noter.
5. Sletning af noter.
6. Soft delete og papirkurv.
7. Gendannelse fra papirkurv.
8. Permanent sletning.
9. Fastgørelse af noter.
10. Arkivering af noter.
11. Søgning i noter og listepunkter.
12. Automatisk gemning.
13. Deling af én enkelt note.
14. E-mailinvitation til en person uden Sharedrive-konto.
15. Sikker gæsteadgang uden konto.
16. Rettighederne:
    - view
    - check
    - edit
17. Tilbagekaldelse af adgang.
18. Udløbsdato på invitationer.
19. Mobilvenlig visning.
20. PWA-understøttelse.
21. Dansk og engelsk oversættelse.

Følgende skal ikke være en del af MVP’en:

- notesamlinger
- deling af grupper af noter
- labels
- påmindelser
- billeder
- vedhæftninger
- avanceret offline-redigering
- CRDT
- realtidssamarbejde via WebSocket
- avanceret versionshistorik
- eksterne gæster med manage-rettighed
- avanceret eksport
- avanceret formatering

Arkitekturen må gerne forberedes på senere udvidelser, men MVP’en skal holdes enkel og stabil.

==================================================
3. NOTE-TYPER
==================================================

Understøt to notetyper:

1. text
2. checklist

Text-note:

- titel
- almindeligt tekstindhold
- ingen HTML
- ingen rich text i MVP
- indhold skal renderes escaped som plain text

Checklist-note:

- titel
- listepunkter
- afkrydsningsstatus
- rækkefølge
- mulighed for at skjule eller vise udførte punkter

En note må ikke skifte type efter oprettelse, medmindre det kan implementeres sikkert og enkelt. Som standard skal note-typen være uforanderlig i MVP’en.

==================================================
4. DATAMODEL
==================================================

Opret PostgreSQL-migrationer efter projektets eksisterende migrationsmønster.

Brug UUID’er, hvis det er projektets eksisterende standard.

Foreslået datamodel:

--------------------------------------------------
notes
--------------------------------------------------

Felter:

- id UUID primary key
- owner_id UUID not null
- type varchar not null
- title text not null default ''
- content text not null default ''
- color varchar nullable
- is_pinned boolean not null default false
- is_archived boolean not null default false
- hide_completed boolean not null default false
- deleted_at timestamptz nullable
- version bigint not null default 1
- created_at timestamptz not null
- updated_at timestamptz not null

Constraints:

- type må kun være text eller checklist
- titel skal have en rimelig maksimumslængde
- content skal have en rimelig maksimumslængde
- owner_id skal referere til eksisterende brugertabel
- permanent slettede noter må fjerne relaterede note-items, shares og sessions efter projektets eksisterende praksis

Indekser:

- owner_id
- updated_at
- is_pinned
- is_archived
- deleted_at
- eventuelt full text search efter eksisterende projektmønster

--------------------------------------------------
note_items
--------------------------------------------------

Felter:

- id UUID primary key
- note_id UUID not null
- content text not null
- is_checked boolean not null default false
- position integer not null
- created_at timestamptz not null
- updated_at timestamptz not null

Constraints:

- note_id skal referere til notes
- position må ikke være negativ
- content skal have en rimelig maksimumslængde
- note_items må kun eksistere for checklist-noter

Indekser:

- note_id
- note_id + position

--------------------------------------------------
note_shares
--------------------------------------------------

Felter:

- id UUID primary key
- note_id UUID not null
- created_by UUID not null
- recipient_email text not null
- permission varchar not null
- invitation_token_hash text not null
- expires_at timestamptz nullable
- revoked_at timestamptz nullable
- last_sent_at timestamptz nullable
- last_opened_at timestamptz nullable
- created_at timestamptz not null
- updated_at timestamptz not null

Constraints:

- permission må kun være view, check eller edit
- recipient_email skal normaliseres
- note_id skal referere til notes
- created_by skal referere til bruger
- kun ejeren må oprette shares i MVP’en
- der må ikke oprettes aktive dubletter for samme note og samme normaliserede e-mail, medmindre projektets UX bevidst tillader det

Indekser:

- note_id
- recipient_email
- invitation_token_hash
- expires_at
- revoked_at

--------------------------------------------------
note_guest_sessions
--------------------------------------------------

Felter:

- id UUID primary key
- share_id UUID not null
- session_token_hash text not null
- expires_at timestamptz not null
- revoked_at timestamptz nullable
- last_accessed_at timestamptz nullable
- created_at timestamptz not null

Constraints:

- share_id skal referere til note_shares
- session_token_hash skal være unik
- sessionen må ikke leve længere end invitationens udløb
- sessioner skal miste adgang straks, hvis share bliver tilbagekaldt

Indekser:

- share_id
- session_token_hash
- expires_at
- revoked_at

--------------------------------------------------
note_activity
--------------------------------------------------

Opret kun denne tabel, hvis projektet ikke allerede har en generel audit-log, der kan genbruges.

Felter:

- id UUID primary key
- note_id UUID nullable
- share_id UUID nullable
- actor_user_id UUID nullable
- actor_email text nullable
- action varchar not null
- metadata jsonb nullable
- created_at timestamptz not null

Brug ellers projektets eksisterende audit-log.

==================================================
5. RIMELIGE BEGRÆNSNINGER
==================================================

Foreslå og dokumenter rimelige grænser.

Som udgangspunkt:

- titel: maks. 300 tegn
- tekstindhold: maks. 100.000 tegn
- listepunkt: maks. 2.000 tegn
- maks. 500 listepunkter pr. note
- maks. 100 aktive invitationer pr. note
- maks. 20 invitationsmails pr. bruger pr. time
- maks. 10 gensendelser pr. invitation pr. time

Tilpas grænserne til eksisterende projektstandarder, hvis sådanne findes.

Valider alle grænser server-side.

==================================================
6. RETTIGHEDER
==================================================

Understøt præcis disse gæsterettigheder i MVP’en:

--------------------------------------------------
view
--------------------------------------------------

Gæsten må:

- se notens titel
- se tekstindhold
- se listepunkter
- se afkrydsningsstatus
- se relevante metadata

Gæsten må ikke:

- redigere noget
- afkrydse punkter
- tilføje punkter
- slette punkter
- ændre rækkefølge
- dele noten
- se ejerens øvrige noter

--------------------------------------------------
check
--------------------------------------------------

Gæsten må:

- alt under view
- ændre is_checked på eksisterende listepunkter
- fjerne afkrydsning igen

Gæsten må ikke:

- ændre titel
- ændre noteindhold
- ændre tekst på listepunkter
- tilføje listepunkter
- slette listepunkter
- ændre rækkefølge
- dele noten

check-rettigheden giver kun mening for checklist-noter.

Backend skal afvise check-rettighed på text-noter eller behandle den som view efter et tydeligt dokumenteret valg. Foretræk at afvise den ved oprettelse af invitationen.

--------------------------------------------------
edit
--------------------------------------------------

Gæsten må:

- alt under view
- redigere titel
- redigere tekstindhold på text-noter
- oprette listepunkter
- redigere listepunkter
- slette listepunkter
- ændre rækkefølge
- ændre afkrydsningsstatus
- ændre hide_completed

Gæsten må ikke:

- dele noten videre
- ændre rettigheder
- se invitationer
- se ejerens øvrige noter
- ændre ejer
- permanent slette noten
- administrere papirkurv
- ændre sikkerhedsindstillinger

Alle rettigheder skal håndhæves server-side på hvert endpoint.

Frontendkontrol er kun UX og må aldrig være eneste sikkerhedslag.

==================================================
7. SIKKER GÆSTEADGANG UDEN KONTO
==================================================

Invitationens URL må ikke bruges som permanent nøgle ved alle efterfølgende API-kald.

Implementer følgende flow:

1. Ejeren åbner delingsdialogen på en note.
2. Ejeren indtaster modtagerens e-mailadresse.
3. Ejeren vælger:
   - view
   - check
   - edit
4. Ejeren vælger eventuelt en udløbsdato.
5. Backend genererer et kryptografisk sikkert invitationstoken.
6. Invitationstokenet skal have høj entropi, eksempelvis mindst 256 bit tilfældighed.
7. Kun en kryptografisk hash af tokenet gemmes i databasen.
8. Det rå token må kun eksistere kortvarigt under oprettelse og mailafsendelse.
9. Tokenet må aldrig logges i klartekst.
10. Invitationen sendes via Sharedrives eksisterende SMTP-service.
11. E-mailen indeholder et link:

    {APP_BASE_URL}/notes/invite/{token}

12. Når modtageren åbner linket, skal serveren:
    - normalisere input
    - hashe tokenet
    - finde invitationen
    - kontrollere revoked_at
    - kontrollere expires_at
    - kontrollere at noten eksisterer
    - kontrollere at noten ikke er permanent slettet
    - kontrollere at ejeren stadig eksisterer
    - kontrollere at invitationen stadig er aktiv

13. Ved gyldig invitation opretter serveren et nyt, separat gæstesessionstoken.

14. Gæstesessionstokenet skal også være kryptografisk sikkert.

15. Kun en hash af gæstesessionstokenet gemmes i note_guest_sessions.

16. Det rå gæstesessionstoken sendes kun i en cookie.

Cookiekrav:

- HttpOnly
- Secure i production
- SameSite=Lax som minimum
- Path skal være så snæver som praktisk muligt
- begrænset Max-Age
- ingen adgang fra JavaScript
- må ikke gemmes i localStorage
- må ikke gemmes i sessionStorage
- må ikke gemmes i IndexedDB

17. Efter succesfuld validering skal browseren omdirigeres med HTTP 303 eller tilsvarende til en ren URL uden invitationstoken:

    /guest/notes/{noteId}

18. Invitationstokenet må ikke indgå i senere API-kald.

19. Alle senere gæste-API-kald skal godkendes via gæstesessionens HttpOnly-cookie.

20. Gæstesessionen skal valideres ved hvert API-kald:

    - sessionen findes
    - sessionen er ikke udløbet
    - sessionen er ikke tilbagekaldt
    - den tilhørende share findes
    - share er ikke tilbagekaldt
    - share er ikke udløbet
    - noten findes
    - noten må stadig deles
    - den ønskede handling er tilladt af permission

21. Ved validering af invitationen skal svar bruge:

    - Cache-Control: no-store
    - Pragma: no-cache, hvis det passer til projektets standard
    - Referrer-Policy: no-referrer eller strict-origin efter en dokumenteret vurdering
    - X-Content-Type-Options: nosniff
    - eksisterende sikkerhedsheaders fra projektet

22. Invitationssiden må ikke indlæse tredjepartsressourcer, analytics eller andre ressourcer, der kan modtage tokenet gennem en referrer.

23. Invitationstokenet skal fjernes fra adresselinjen hurtigst muligt.

24. Ved ugyldigt, udløbet eller tilbagekaldt token skal der vises en generisk besked:

    “Dette invitationslink er ugyldigt eller ikke længere aktivt.”

Undgå at afsløre præcis hvorfor adgangen blev afvist.

25. Recipient_email må bruges til visning og audit-log, men må aldrig bruges som autentifikation.

26. Gæstevisningen skal vise:

    “Du ser denne note som gæst: recipient@example.com”

27. Når invitationen tilbagekaldes:

    - revoked_at sættes
    - alle aktive note_guest_sessions til denne share tilbagekaldes eller bliver øjeblikkeligt ugyldige
    - adgang skal ophøre ved næste API-kald
    - det gamle invitationslink må ikke kunne oprette nye sessioner

28. Når invitationens rettighed ændres:

    - den nye rettighed skal gælde straks
    - eksisterende sessions må ikke beholde den gamle rettighed
    - permission skal altid læses fra share ved hvert relevant API-kald

29. Når invitationens udløbsdato ændres:

    - eksisterende sessions må ikke have længere levetid end den nye udløbsdato
    - hvis invitationen nu er udløbet, skal sessions miste adgang straks

30. Når brugeren logger ud som gæst:

    - sessionen tilbagekaldes eller slettes
    - cookien slettes
    - der returneres til en neutral side

31. En invitation må kunne åbnes igen og oprette en ny session, så længe den ikke er udløbet eller tilbagekaldt.

Invitationstokenet behøver ikke være et strengt engangstoken i MVP’en. Det skal fungere som en invitationsnøgle, der veksles til kortvarige sessions. Dokumenter denne forskel tydeligt.

==================================================
8. GÆSTESESSIONENS LEVETID
==================================================

Foreslå en sikker standard.

Som udgangspunkt:

- gæstesession: 24 timer
- sessionen må aldrig leve længere end share.expires_at
- last_accessed_at opdateres med rimelig throttling
- absolut udløb foretrækkes fremfor ubegrænset sliding expiration
- ejeren kan altid tilbagekalde adgangen

Implementer ikke “husk mig” i MVP’en.

==================================================
9. CSRF OG COOKIE-SIKKERHED
==================================================

State-changing gæste-endpoints skal beskyttes mod CSRF.

Genbrug projektets eksisterende CSRF-model.

Hvis projektet anvender:

- SameSite-cookie
- CSRF-token
- origin-kontrol
- custom header

skal samme mønster bruges på gæsteendpoints.

Som minimum skal backend validere Origin eller Referer på ændrende gæstekald, hvis dette stemmer med projektets arkitektur.

Dokumenter præcist hvordan CSRF-beskyttelsen fungerer.

==================================================
10. API
==================================================

Følg Sharedrives eksisterende API-navngivning.

Brug som udgangspunkt /api/v1.

--------------------------------------------------
Autentificerede note-endpoints
--------------------------------------------------

GET    /api/v1/notes
POST   /api/v1/notes
GET    /api/v1/notes/:id
PATCH  /api/v1/notes/:id
DELETE /api/v1/notes/:id

POST   /api/v1/notes/:id/restore
DELETE /api/v1/notes/:id/permanent

GET    /api/v1/notes/:id/items
POST   /api/v1/notes/:id/items
PATCH  /api/v1/notes/:id/items/:itemId
DELETE /api/v1/notes/:id/items/:itemId
POST   /api/v1/notes/:id/items/reorder

--------------------------------------------------
Deling
--------------------------------------------------

GET    /api/v1/notes/:id/shares
POST   /api/v1/notes/:id/shares
PATCH  /api/v1/notes/:id/shares/:shareId
DELETE /api/v1/notes/:id/shares/:shareId
POST   /api/v1/notes/:id/shares/:shareId/resend

--------------------------------------------------
Offentlig invitation
--------------------------------------------------

GET eller POST
/api/v1/public/notes/invitations/:token/accept

Vælg den metode, der passer bedst til sikkerhedsmodellen.

Foretræk en serverkontrolleret accept-flow, som:

- validerer token
- opretter session
- sætter cookie
- laver redirect
- ikke returnerer tokenet til frontend-JavaScript

--------------------------------------------------
Gæsteendpoints
--------------------------------------------------

GET    /api/v1/guest/notes/:id
PATCH  /api/v1/guest/notes/:id
POST   /api/v1/guest/notes/:id/items
PATCH  /api/v1/guest/notes/:id/items/:itemId
DELETE /api/v1/guest/notes/:id/items/:itemId
POST   /api/v1/guest/notes/:id/items/reorder
POST   /api/v1/guest/logout

Tilpas endpointnavnene til eksisterende projektstandarder, hvis nødvendigt.

Alle endpoints skal have:

- inputvalidering
- ensartet fejlformat
- server-side rettighedskontrol
- sikker fejlbehandling
- audit logging
- passende rate limiting
- ingen følsomme oplysninger i logs

==================================================
11. LISTNING, SØGNING OG FILTRERING
==================================================

GET /api/v1/notes skal understøtte:

- pagination
- søgning
- sortering
- pinned
- archived
- deleted
- type

Standardvisning:

- ikke arkiverede noter
- ikke slettede noter
- fastgjorte noter først
- derefter senest opdaterede

Søgning skal som minimum søge i:

- titel
- text-note content
- checklist-item content

Brug eksisterende PostgreSQL-søgemønstre, hvis projektet allerede har dem.

==================================================
12. OPTIMISTIC LOCKING
==================================================

Brug notes.version til konfliktbeskyttelse.

Ved opdatering:

- klienten sender den version, den redigerede
- backend opdaterer kun, hvis version stadig matcher
- backend øger version med 1
- ved konflikt returneres HTTP 409

Frontend skal vise:

“Noten er blevet ændret et andet sted. Genindlæs for at se den nyeste version.”

Undgå automatisk at overskrive nyere ændringer.

For ændringer af listepunkter skal note-versionen også opdateres, så ændringer registreres som en del af notens samlede version.

==================================================
13. AUTOSAVE
==================================================

Implementer autosave med debounce.

Krav:

- gem efter kort pause i redigering
- undgå API-kald for hvert tastetryk
- vis status:
  - Gemmer…
  - Gemt
  - Kunne ikke gemme
- retry må ikke skabe duplikerede listepunkter
- frontend skal kunne håndtere 409-konflikter
- ingen lokal permanent lagring af gæstedata i MVP’en
- send ikke tomme eller uændrede updates unødvendigt

==================================================
14. FRONTEND
==================================================

Tilføj “Noter” til Sharedrives eksisterende hovednavigation.

Brug eksisterende layout, farver, typografi, kort, knapper, modaler, inputfelter og toast-komponenter.

Opret sider:

- /notes
- /notes/archive
- /notes/trash
- /notes/:id
- /guest/notes/:id
- /notes/invite/:token

Invitationens token-side må gerne være en serverredirect eller en minimal frontendside, men tokenet skal fjernes fra URL’en straks efter validering.

--------------------------------------------------
Noteside
--------------------------------------------------

Vis:

- knap til ny tekstnote
- knap til ny huskeliste
- søgefelt
- fastgjorte noter øverst
- øvrige noter nedenunder
- adgang til arkiv
- adgang til papirkurv

Kort skal vise:

- titel
- tekstudsnit eller de første listepunkter
- afkrydsningsstatus
- antal udførte punkter
- fastgjort-status
- delt-status
- sidst ændret
- menu med:
  - rediger
  - del
  - fastgør/frigør
  - arkiver
  - flyt til papirkurv

--------------------------------------------------
Text-editor
--------------------------------------------------

Text-note-editor skal have:

- titel
- plain text-felt
- autosave
- gemmestatus
- mulighed for fastgørelse
- arkivering
- deling
- sletning

Genbrug teksteditorens designkomponenter, hvis de passer, men brug ikke filsystemet eller `.txt`-filer som lagring.

Noter skal være databaseobjekter.

--------------------------------------------------
Checklist-editor
--------------------------------------------------

Checklist-editor skal have:

- titel
- afkrydsningsfelter
- tilføj nyt punkt
- rediger punkt
- slet punkt
- ændr rækkefølge
- skjul eller vis udførte punkter
- autosave

Tastaturadfærd:

- Enter på et punkt opretter et nyt punkt nedenunder
- Backspace på et tomt punkt fjerner punktet
- Escape må lukke dialog efter eksisterende projektmønster
- tastaturnavigation skal fungere

Rækkefølge:

- drag-and-drop på desktop, hvis projektet allerede bruger en egnet løsning
- tilgængelige op/ned-knapper som alternativ
- touchvenlig løsning på mobil

--------------------------------------------------
Delingsdialog
--------------------------------------------------

Delingsdialogen skal vise:

- modtagerens e-mailadresse
- valg af permission
- valgfri udløbsdato
- send invitation
- aktive invitationer
- status
- permission
- udløbsdato
- senest sendt
- gensend
- ændr permission
- tilbagekald

Kun noteejeren må se og administrere delinger i MVP’en.

--------------------------------------------------
Gæstevisning
--------------------------------------------------

Gæstevisningen skal vise:

- noteindhold
- den tilladte redigeringsgrad
- tydelig gæstebesked
- modtagerens e-mailadresse
- eventuel udløbsdato
- logout eller “Luk gæsteadgang”

Tekst:

“Du ser denne note som gæst: recipient@example.com”

Ved view:

- alle redigeringskontroller skjules eller deaktiveres

Ved check:

- kun afkrydsningsfelter er aktive

Ved edit:

- relevante redigeringskontroller er aktive
- delingsfunktioner må ikke vises

==================================================
15. MOBIL OG RESPONSIVT DESIGN
==================================================

Løsningen skal fungere godt på telefon, tablet og desktop.

Krav:

- ingen vandret scrolling
- touchvenlige afkrydsningsfelter
- touchvenlige menuer
- tilstrækkelige trykflader
- én kolonne på små skærme
- flere kolonner på større skærme
- modal kan blive bottom sheet på mobil, hvis eksisterende design understøtter det
- editoren skal fungere med mobilt tastatur
- fast handlingsknap til ny note kan bruges på mobil

==================================================
16. PWA
==================================================

Sharedrive er allerede en PWA.

Udvid den eksisterende PWA i stedet for at oprette en ny.

Krav:

- /notes skal fungere i installeret PWA
- /guest/notes/:id skal fungere i installeret PWA
- tilføj eventuelt app shortcut til:
  - Ny note
  - Ny huskeliste
- private note-API-svar må ikke caches ukontrolleret
- gæstesider og gæste-API-svar skal bruge no-store
- gæstecookies må ikke eksponeres for service worker-kode
- offlineindikator skal genbruges
- MVP’en må ikke love offline-redigering

Hvis appen er offline:

- noter må gerne kunne vises som utilgængelige
- vis en tydelig besked
- ændringer må ikke gemmes lokalt uden en sikker synkroniseringsmodel

==================================================
17. SMTP OG E-MAILTEMPLATE
==================================================

Genbrug Sharedrives eksisterende SMTP-konfiguration.

Opret e-mailtemplates på dansk og engelsk.

Invitationen skal indeholde:

- navnet på Sharedrive-installationen
- noteejeren eller afsenderens navn, hvis tilgængeligt
- notens titel
- permission i menneskeligt sprog
- udløbsdato, hvis angivet
- invitationsknap
- fallback-link
- sikkerhedstekst om ikke at videresende linket
- besked om at modtageren ikke behøver oprette konto

Danske rettighedstekster:

- view: Kan se
- check: Kan afkrydse
- edit: Kan redigere

Engelske rettighedstekster:

- view: Can view
- check: Can check items
- edit: Can edit

E-mailen må ikke indeholde følsomt noteindhold.

Log ikke det fulde invitationslink.

==================================================
18. RATE LIMITING
==================================================

Genbrug projektets eksisterende rate limiter.

Tilføj beskyttelse på:

- oprettelse af invitation
- gensendelse
- tokenvalidering
- sessionsoprettelse
- gæstelogin-forsøg
- ændrende gæstekald
- gentagne ugyldige tokens

Rate limiting bør tage hensyn til:

- bruger-id
- IP
- share-id
- endpoint

Undgå at give angribere mulighed for at enumerere gyldige invitationer.

==================================================
19. AUDIT LOGGING
==================================================

Brug projektets eksisterende audit-system.

Log som minimum:

- note oprettet
- note ændret
- note arkiveret
- note slettet
- note gendannet
- note permanent slettet
- note fastgjort
- invitation oprettet
- invitation sendt
- invitation gensendt
- invitation åbnet
- gæstesession oprettet
- gæst så note
- gæst ændrede note
- gæst afkrydsede punkt
- permission ændret
- udløbsdato ændret
- invitation tilbagekaldt
- gæstesession tilbagekaldt
- adgang afvist

Log aldrig:

- invitationstoken i klartekst
- sessionstoken i klartekst
- hele noteindholdet
- følsomme cookies

==================================================
20. SIKKERHED
==================================================

Følg Sharedrives eksisterende sikkerhedsmodel.

Krav:

- kryptografisk sikre tokens
- tokenhash i databasen
- sikre cookies
- server-side autorisation
- CSRF-beskyttelse
- rate limiting
- inputvalidering
- output escaping
- ingen HTML fra noteindhold
- ingen XSS
- ingen SQL injection
- ingen adgang via ændret UUID
- ingen adgang til andre noter gennem guest-session
- ingen permanent adgang via URL-token
- ingen tokens i localStorage
- ingen tokens i logs
- no-store på gæsteressourcer
- generiske tokenfejl
- kontroller noteejerskab på alle share-operationer
- kontroller permission på alle gæsteoperationer

Anvend konstante sammenligninger, hvor det er relevant og understøttet af den valgte hashmodel.

Brug ikke en hurtig passwordhash som bcrypt til random tokens, medmindre projektet allerede har et velbegrundet mønster. En sikker SHA-256- eller HMAC-baseret tokenhash kan være passende til tokens med høj entropi. Dokumenter valget.

==================================================
21. SOFT DELETE OG DELING
==================================================

Når en note flyttes til papirkurven:

- ejeren kan stadig gendanne den
- gæsteadgang skal som udgangspunkt suspenderes
- gæste-API skal returnere en generisk utilgængelig fejl

Når noten gendannes:

- shares må gerne blive aktive igen, hvis de ikke er udløbet eller tilbagekaldt
- dokumenter dette valg

Når noten permanent slettes:

- shares fjernes eller anonymiseres efter projektets praksis
- guest sessions fjernes
- note items fjernes
- audit-log bevares efter eksisterende politik

==================================================
22. REALTID OG KONFLIKTER
==================================================

Implementer ikke kompleks realtidssynkronisering i MVP’en.

Brug:

- REST
- autosave
- opdatering ved fokus
- eventuelt let polling, hvis nødvendigt
- optimistic locking med version

Hvis projektet allerede har en enkel SSE-løsning, kan den bruges til at signalere, at en note er ændret.

Introducer ikke WebSocket eller CRDT alene for denne funktion.

==================================================
23. INTERNATIONALISERING
==================================================

Alle nye tekster skal ligge i Sharedrives eksisterende i18n-system.

Tilføj fuld dansk og engelsk oversættelse.

Ingen hardcodede brugerfladetekster i komponenterne.

Oversæt som minimum:

- Noter
- Ny note
- Ny huskeliste
- Fastgjort
- Arkiv
- Papirkurv
- Del
- Kan se
- Kan afkrydse
- Kan redigere
- Udløber
- Gensend invitation
- Tilbagekald adgang
- Gemmer…
- Gemt
- Kunne ikke gemme
- Du ser denne note som gæst
- Invitationslinket er ugyldigt eller ikke længere aktivt
- Noten er blevet ændret et andet sted

==================================================
24. TILGÆNGELIGHED
==================================================

Krav:

- tastaturnavigation
- synlig fokusmarkering
- korrekte labels
- ARIA-labels, hvor nødvendigt
- semantisk HTML
- god kontrast
- tilgængelige modaler
- fokusfangst i modaler
- Escape lukker dialoger efter eksisterende mønster
- afkrydsningsfelter skal have tilknyttet tekstlabel
- drag-and-drop skal have et tastaturalternativ

==================================================
25. TESTS
==================================================

Følg projektets eksisterende teststruktur.

--------------------------------------------------
Backendtests
--------------------------------------------------

Test:

1. Opret text-note.
2. Opret checklist-note.
3. Rediger titel.
4. Rediger content.
5. Opret listepunkt.
6. Rediger listepunkt.
7. Slet listepunkt.
8. Omarranger listepunkter.
9. Afkryds punkt.
10. Fastgør note.
11. Arkiver note.
12. Flyt note til papirkurv.
13. Gendan note.
14. Permanent slet note.
15. Søg i titel.
16. Søg i noteindhold.
17. Søg i listepunkter.
18. Bruger kan ikke læse anden brugers note.
19. Bruger kan ikke ændre anden brugers note.
20. Kun ejer kan administrere shares.
21. Opret view-invitation.
22. Opret check-invitation.
23. Opret edit-invitation.
24. Afvis check-invitation til text-note.
25. Send invitation via mock eller eksisterende testmailservice.
26. Valider gyldigt invitationstoken.
27. Afvis ugyldigt token.
28. Afvis udløbet token.
29. Afvis tilbagekaldt token.
30. Opret gæstesession.
31. Gæstesession lagres kun som hash.
32. View-gæst kan læse.
33. View-gæst kan ikke ændre.
34. Check-gæst kan ændre is_checked.
35. Check-gæst kan ikke redigere tekst.
36. Edit-gæst kan redigere.
37. Edit-gæst kan ikke dele videre.
38. Gæst kan ikke hente anden note ved at ændre UUID.
39. Tilbagekaldelse stopper eksisterende session.
40. Permissionændring gælder eksisterende session straks.
41. Udløbsændring gælder eksisterende session straks.
42. Logout tilbagekalder eller sletter session.
43. Cookie har de forventede sikkerhedsflags.
44. Gæstesvar bruger Cache-Control: no-store.
45. Rate limiting virker.
46. Audit log oprettes.
47. 409 returneres ved versionskonflikt.
48. Token og sessionstoken optræder ikke i logs.

--------------------------------------------------
Frontendtests
--------------------------------------------------

Hvis projektet har frontendtestopsætning, test:

1. Opret text-note.
2. Opret checklist-note.
3. Autosave.
4. Gemt-status.
5. Fejlstatus.
6. Afkryds punkt.
7. Omarranger punkt.
8. Arkiver note.
9. Slet note.
10. Delingsdialog.
11. Opret invitation.
12. Gensend invitation.
13. Tilbagekald invitation.
14. View-gæstevisning.
15. Check-gæstevisning.
16. Edit-gæstevisning.
17. Mobilvisning.
18. Tastaturnavigation.
19. 409-konflikt.
20. Ugyldigt invitationslink.

==================================================
26. BACKUP OG RESTORE
==================================================

Tilføj noter til Sharedrives eksisterende backup- og restorefunktion.

Backup skal inkludere:

- notes
- note_items
- note_shares
- relevante metadata

Vurder om aktive guest sessions skal medtages.

Som udgangspunkt bør gæstesessioner ikke gendannes fra backup, fordi de er kortvarige sikkerhedsobjekter. Dokumenter dette valg.

Invitationstokenhashes må gerne gendannes, hvis eksisterende invitationslinks fortsat skal virke efter restore. Vurder sikkerhedsimplikationerne og dokumenter valget.

==================================================
27. DOKUMENTATION
==================================================

Opdater README og relevant dokumentation.

Dokumenter:

- hvad Noter-modulet kan
- forskellen mellem text og checklist
- rettighederne view, check og edit
- hvordan gæsteadgang uden konto fungerer
- at URL-token veksles til en kortvarig HttpOnly-session
- at tokenet ikke bruges ved efterfølgende API-kald
- SMTP-krav
- sikkerhedsmodel
- udløb og tilbagekaldelse
- PWA-brug
- backup og restore
- migrationsfiler
- API-endpoints
- kendte begrænsninger i MVP’en

==================================================
28. IMPLEMENTERINGSFASER
==================================================

Implementer i disse faser:

--------------------------------------------------
Fase 1: Fundament
--------------------------------------------------

- migrationsfiler
- modeller
- repositories
- services
- autentificerede note-endpoints
- note-items
- optimistic locking
- grundlæggende tests

--------------------------------------------------
Fase 2: Frontend
--------------------------------------------------

- navigation
- noteside
- text-note-editor
- checklist-editor
- autosave
- arkiv
- papirkurv
- søgning
- responsivt design
- i18n

--------------------------------------------------
Fase 3: Deling
--------------------------------------------------

- note_shares
- delingsdialog
- SMTP-template
- invitationstoken
- hashning
- invitation send og gensend
- tilbagekaldelse
- permissionændring
- udløbsdato

--------------------------------------------------
Fase 4: Gæsteadgang
--------------------------------------------------

- tokenvalidering
- gæstesession
- HttpOnly-cookie
- redirect uden token
- gæste-API
- view/check/edit
- logout
- rate limiting
- CSRF
- no-store
- audit logging

--------------------------------------------------
Fase 5: PWA, backup og dokumentation
--------------------------------------------------

- PWA-ruter
- manifest shortcut, hvis passende
- service-worker-regler
- backup
- restore
- dokumentation
- komplette tests

==================================================
29. ACCEPTKRITERIER
==================================================

Løsningen er først færdig, når:

1. En bruger kan oprette en text-note.
2. En bruger kan oprette en checklist-note.
3. En bruger kan afkrydse punkter.
4. Noter gemmes automatisk.
5. Noter kan fastgøres.
6. Noter kan arkiveres.
7. Noter kan flyttes til papirkurv.
8. Noter kan gendannes.
9. En ejer kan dele en note med en e-mailadresse.
10. Modtageren behøver ikke oprette konto.
11. Modtageren får et invitationslink via SMTP.
12. Invitationslinket valideres server-side.
13. Browseren får en kortvarig HttpOnly-cookie.
14. Invitationstokenet fjernes fra URL’en efter validering.
15. Invitationstokenet bruges ikke ved senere API-kald.
16. View-gæst kan kun se.
17. Check-gæst kan kun afkrydse.
18. Edit-gæst kan redigere noten.
19. Gæsten kan ikke se andre noter.
20. Ejeren kan tilbagekalde adgang.
21. Tilbagekaldelse virker straks.
22. Permissionændringer gælder straks.
23. Udløb håndhæves server-side.
24. Gæstesvar caches ikke.
25. Tokens optræder ikke i logs.
26. Løsningen virker på mobil.
27. Løsningen virker i Sharedrives PWA.
28. Dansk og engelsk er implementeret.
29. Tests består.
30. Eksisterende Sharedrive-funktionalitet er ikke ødelagt.

==================================================
30. AFSLUTTENDE RAPPORT
==================================================

Når implementeringen er færdig, skal du levere:

1. Kort arkitekturoversigt.
2. Liste over alle ændrede og nye filer.
3. Liste over migrationsfiler.
4. Liste over nye API-endpoints.
5. Beskrivelse af invitationsflowet.
6. Beskrivelse af gæstesessionens sikkerhed.
7. Cookieindstillinger.
8. CSRF-beskyttelse.
9. Rate limits.
10. Audit events.
11. Testresultater.
12. Kendte begrænsninger.
13. Forslag til næste fase.

Skriv ikke, at noget er færdigt, hvis tests, build eller migrationskontrol fejler.

Brug ikke mock-data i den færdige løsning.

Implementer løsningen som produktionsklar MVP-kode, ikke som en visuel prototype.
