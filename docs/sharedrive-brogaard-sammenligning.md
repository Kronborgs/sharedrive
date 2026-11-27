# Sharedrive sammenlignet med Brogaard Suite

Brogaard Suites hovedgren er kontrolleret ved revision `e0f4c8a1847138114d6651d685bec8ef960d97d9`. Sharedrive er gennemgået ved revision `358f5a7` med lokale ændringer til MBOX og vedhæftninger. **I koden** betyder, at funktionen findes i Sharedrive. Lokale tests med simuleret Mailcow og brugerens bekræftelser fra testserveren er angivet særskilt. [Brogaard Suites funktionsoversigt](https://github.com/mrbridgefarm/Brogaard-Suite/blob/e0f4c8a1847138114d6651d685bec8ef960d97d9/README.md)

## Mail

| Funktion | Brogaard Suite | Sharedrive |
| --- | --- | --- |
| Mapper og beskeder | IMAP-mapper, ulæsttal, løbende indlæsning og **Indlæs alle**. | I koden, med visning af undermapper under deres overordnede mappe. |
| Læserude | Tre kolonner eller vandret deling. Lys og mørk læsning samt styring af eksterne billeder. | I koden. Eksterne billeder hentes efter brugerens valg. |
| Søgning og filtre | Søg på tværs af mapper. Filtrér på ulæst, stjerner og vedhæftninger. | I koden. |
| Ny mail og kladder | Ny mail, svar, videresendelse, kladder, billeder og filer som vedhæftninger. | I koden. Lokal browsertest dækkede filer og billeder. |
| Afsendere og signaturer | Automatisk hentning af SOGo-aliaser, valgfri Mailcow-læsenøgle og signaturer pr. afsenderidentitet. | I koden. Signaturer gemmes i Sharedrive. Synk til SOGos egne signaturer mangler. Skjulte aliaser kræver `MAILCOW_API_URL` og `MAILCOW_API_KEY` på den konfigurerede HTTPS-vært. |
| Serverfiltre og spam | ManageSieve-regler, Rspamd spamtræning og tømning af spam eller papirkurv. | I koden. ManageSieve og spamtræning skal prøves på den tilsluttede Mailcow. |
| Genveje og opdatering | Kopiér, klip og indsæt mellem mapper, fortryd og automatisk opdatering ved interval eller fokus. | I koden. |
| Mailarkiver | EML og MBOX blev ikke fundet i den sammenlignede Brogaard-kode. | EML-import af flere filer til valgt mappe og eksport af én besked ad gangen er i den committede kode. MBOX-import og -eksport af én mappe ad gangen ligger lokalt og er testet med simuleret IMAP. Grænsen er 20 MiB og 10.000 mails pr. MBOX-arkiv. |
| Åbn vedhæftninger | Vedhæftninger håndteres i webmail. | Office, tekst, STL og 3MF kan gemmes som private kopier og åbnes i Sharedrives egne værktøjer. Office kræver OnlyOffice. PDF og andre egnede medier kan åbnes i browseren. Øvrige filer hentes. Rettelsen til kopier af `.env`, `.gitignore` og `Dockerfile` ved navnesammenfald ligger lokalt. |
| Filer og mapper i personlig mail | Sharedrive-specifikt. | **Del → Link** og **Tilføj til e-mail** kan åbne en personlig mail med et nyt eller eksisterende link. **Del → Bruger** følger fortsat Sharedrives almindelige delingsflow og SMTP. Kladden og brugerflowet er testet lokalt med fiktive data. |

## Kalender

| Funktion | Brogaard Suite | Sharedrive |
| --- | --- | --- |
| Visninger og aftaler | År, måned, uge, dag og liste, ugenumre samt træk for at flytte aftaler eller ændre varighed. | I koden med de fem visninger. |
| Kalenderliste | Standardkalender til nye aftaler, egne og delte kalendere samt abonnementer. | I koden. |
| SOGo-deling | Del med kolleger som læseadgang eller læse- og skriveadgang. Find delte kalendere og abonnér på dem. | I koden. Rettighederne skal afprøves på den tilsluttede SOGo. |
| Offentlige kalendere | Læselinks med udløb. | I koden. Afvisning af udløbne links er testet lokalt. |
| Farver og synk | Synkronisering af kalenderfarver med SOGo samt valg af automatisk eller manuel opdatering. | I koden. Farvesynk begge veje skal afprøves på den tilsluttede SOGo. |
| Helligdage og abonnementer | Danske helligdage og abonnementer på eksterne ICS-feeds. | I koden. Sharedrive bruger HTTPS til eksterne kalendere og omskriver `webcal://` til HTTPS. |
| Fødselsdage og mærkedage | Kontaktbaseret kalender og mulighed for CalDAV-synk. | I koden. Synk til SOGo skal prøves på den tilsluttede Mailcow. |
| ICS og oprydning | ICS-import og -eksport, papirkurv, gendannelse, sletning af flere aftaler samt kopiering og fortrydelse. | I koden. ICS-import og -eksport bestod lokal browsertest. |

## Kontakter

| Funktion | Brogaard Suite | Sharedrive |
| --- | --- | --- |
| Adressebøger | CardDAV-synk begge veje med personlige, delte og skrivebeskyttede adressebøger. | I koden. Hvis en bog fejler under synk, bevares dens tidligere hentede kontakter. Det blev testet lokalt. Læsning og skrivning begge veje skal prøves på den tilsluttede SOGo. |
| Kontaktkort | Navn, firma og titel, flere e-mails og telefonnumre, adresser og kortlink, noter, tags, fødselsdage og mærkedage. | I koden. |
| Billeder og favoritter | Kontaktbilleder, Gravatar og favoritmarkering, også på skrivebeskyttede bøger. | I koden. Automatisk Gravatar er et frivilligt valg i Sharedrive. |
| Flere kontakter ad gangen | Flermarkering, masseredigering af tags og firma, favoritter, sletning, VCF-eksport og mail i BCC. | I koden. Redigering og sletning følger adressebogens tilladelser. |
| VCF-import og -eksport | vCard 3.0 med støtte til eksterne profilbilleder. | I koden. VCF-import og -eksport bestod lokal browsertest. Eksterne billeder behandles særskilt af serveren. |

## Fælles funktioner

| Funktion | Brogaard Suite | Sharedrive |
| --- | --- | --- |
| Konto og adgang | Fælles Mailcow-login til Mail, Kalender og Kontakter. | Sharedrive-login med individuel Mailcow-tilknytning og en adminafbryder for modulet. Brugeren har bekræftet to fungerende Sharedrive-brugere med hver sin mailkonto. |
| Mail, kalender og kontakter sammen | Kontaktforslag ved mail og mødedeltagere, gem afsender som kontakt, opret aftale fra mail, og konflikttjek ved ICS-invitationer. Mail fra en kontakt eller fra en markering i BCC. | I koden. Modulerne kan skiftes med Alt+1, Alt+2 og Alt+3. |
| Temaer | 11 fælles temaer. | Alle 11 findes i Sharedrive. Admin kan uploade egne temaer og administrere, hvilke temaer der vises. |
| App og offline | Brogaard beskriver installation og offline-understøttelse. | Mail kan installeres som app. En åbnet session kan bruge lokal cache, og kalenderen kan sætte ændringer i kø. Genåbning af privat mail offline mangler. |

Bekræftet på testserveren af brugeren er temaerne og separate Mailcow-konti. Afprøvning af SOGo-adgang og -farver, fødselsdagssynk, Sieve, spamtræning, SMTP-afsendelse med delingsflow og MBOX mod den konkrete Mailcow står stadig tilbage.
