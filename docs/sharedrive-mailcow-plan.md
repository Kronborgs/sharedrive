# Arbejdsplan for Mailcow i Sharedrive

Sharedrive får et valgfrit modul med Mail, Kalender og Kontakter i React. Go ejer brugeradgang og kontotilknytning. Mailcow og SOGo forbliver datakilden. Temaet styres af Sharedrive og virker også uden Mailcow.

## 1. Temaer i Sharedrive

- Første ændring: Brug Nordisk Blå Time som standard på login og i Sharedrive. Behold Klassisk mørk som valgmulighed. Genbrug den [originale fjordbaggrund](https://github.com/mrbridgefarm/Brogaard-Suite/blob/e0f4c8a1847138114d6651d685bec8ef960d97d9/frontend/public/themes/nordic-blue-hour.jpg). Gem valget lokalt, så det også bruges på login. Kilde: [Brogaards temapaletter](https://github.com/mrbridgefarm/Brogaard-Suite/blob/e0f4c8a1847138114d6651d685bec8ef960d97d9/frontend/src/composables/useTheme.ts).
- Gennemgå filer, noter, chat, administration, login og gæstesider på mobil og desktop. Flyt relevante hårdkodede farver til fælles CSS-variabler. Bevar farver, der kommunikerer status, fejl eller filtype.
- Klar når temaet kan skiftes med tastatur, overlever genindlæsning, følger brugeren mellem sider og stadig har læsbar kontrast på alle de undersøgte skærme.

## 2. Afprøv genbrug af Brogaards Mailcow-kode

Den første [lokale forbindelsesprøve](../services/mailcow/README.md) er implementeret. Den genbruger Brogaards IMAP-klient og afprøver godkendelse og adgang via de fire protokoller.

- Start med Brogaards `mailClient.ts` (IMAP/SMTP), `davClient.ts` og `icalMapper.ts` (CalDAV) samt `carddavClient.ts` (CardDAV), alle under `backend/src/services`. Kortlæg, hvilke dele der kan bruges uden Brogaards egen session og Express-ruter. Importér de nødvendige dele med dokumenteret commit-id fra [Brogaard Suite](https://github.com/mrbridgefarm/Brogaard-Suite). Hold Sharedrives integrationskode adskilt fra de importerede filer.
- Kør klienterne i en intern Node-tjeneste med et lille API til Go. Sharedrive er det offentlige indgangspunkt. Den nuværende adminprøve gemmer én værtsadresse under Administration → Indstillinger → SMTP. Det er en diagnosefunktion. Brugernes kontotilknytning bruger den enkelte kontos eget værtsnavn.
- Brug to separate testkonti til at bekræfte TLS, app-adgangskoder, modtagelse og afsendelse af mail samt læsning og skrivning af en aftale og kontakt. Kontrollér ændringerne i SOGo og at den anden konto ikke kan læse private data.

## 3. Kontotilknytning og brugerflade

Kontotilknytning er implementeret lokalt i **Min Mailcow-konto** i brugermenuen. Den gemmer brugerens egen vært og konto, kan prøve forbindelsen og kan frakoble kontoen. Mail-, kalender- og kontaktvisningerne følger i næste etape.

- Tilføj en administratorindstilling, der aktiverer modulet. Hver bruger angiver sit eget Mailcow-værtsnavn, sin mailadresse og sin applikationsadgangskode og kan frakoble kontoen. To brugere kan bruge samme Mailcow-server eller hver sin. Go henter værten og de krypterede legitimationsoplysninger for den indloggede Sharedrive-bruger og kontrollerer ejerskab ved hver forespørgsel. Bevar validering af værtsnavn, DNS og TLS som i forbindelsesprøven. Administratorens testvært begrænser ikke brugernes valg af server.
- Tilføj Mail, Kalender og Kontakter i Sharedrives menu. Første version dækker indbakke, læsning og afsendelse af mail, kalender og aftaler samt søgning, oprettelse og redigering af kontakter.
- Byg Brogaards centrale arbejdsgange: kontaktforslag i ny mail, gem afsender som kontakt og tilføj en mailinvitation med konflikttjek.
- Klar når hele forløbet fra mail til kontakt og kalender virker på testserveren, to konti er adskilt, og frakobling eller deaktivering stopper adgangen. Prøv først to Sharedrive-brugere med hver sin postkasse på samme Mailcow-server. Prøv derefter værtsvalg med to forskellige Mailcow-servere, når en ekstra server er tilgængelig. Kontrollér også Sharedrives eksisterende SMTP-notifikationer.

## 4. Levering og opdateringer

- Vis de lokale ændringer og checks til godkendelse før commit. Brug derefter GitLab-testserveren til funktionel afprøvning i henhold til AGENTS.md. Beta- og latest-promovering håndteres separat af brugeren.
- Gennemgå nye Brogaard-versioner mod den fastlåste revision. Opdater importerede filer i en særskilt ændring, gentag funktionstesten og vælg hvilke nye Vue-funktioner der skal overføres til React.
- Prioritér flere temaer, delte postkasser og kalendere samt vedhæftning fra Sharedrive efter første version.
