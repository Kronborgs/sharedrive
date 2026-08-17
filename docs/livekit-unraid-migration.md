# Sikker LiveKit-migrering på eksisterende Unraid-Sharedrive

Denne procedure tilføjer Rooms voice til en eksisterende Sharedrive-installation.
Den opretter ikke en ny Sharedrive-installation og ændrer ikke PostgreSQL, Redis,
filer, Notes, backups eller eksisterende Sharedrive-container.

## Før du starter

1. Bekræft at den eksisterende Sharedrive-backup kan ses og er brugbar.
2. Notér den nuværende Sharedrive-container, dens mounts, netværk og IP. De må
   ikke ændres i denne migrering.
3. Hav den eksisterende `LIVEKIT_API_KEY` og `LIVEKIT_API_SECRET` fra
   Sharedrive-template klar. De bruges også i LiveKit-konfigurationen.

## Trin 1: Opret kun LiveKit-konfigurationen

Opret mappen `/mnt/user/appdata/sharedrive/livekit` og kopiér
`livekit.yaml.example` fra samme Sharedrive-release til
`/mnt/user/appdata/sharedrive/livekit/livekit.yaml`.

I filen erstattes disse tre værdier:

- `replace_with_livekit_api_key` med `LIVEKIT_API_KEY`.
- `replace_with_livekit_api_secret` med `LIVEKIT_API_SECRET`.
- `livekit.yourdomain.com` med `livekit.kronborgs.dk`.

Bevar den valgte UDP-range `52000-52999`; den skal svare til firewall-reglerne.

## Trin 2: Tilføj LiveKit som én ny container

Importér `unraid/sharedrive-livekit.xml` fra samme Sharedrive-release i Unraid.

- Vælg samme Docker-netværkstype/VLAN som Sharedrive bruger, men tildel LiveKit
  sin egen ledige IP.
- Bevar Sharedrive, PostgreSQL og Redis uændrede og kørende.
- Start derefter kun `sharedrive-livekit`.

En kørende LiveKit-container er et additivt trin: Sharedrive fungerer uændret,
indtil voice-forbindelsen er testet.

## Trin 3: Ret kun LiveKit-proxyen

I Nginx Proxy Manager sættes `livekit.kronborgs.dk` til LiveKit-containerens nye
IP på HTTP port `7880`, med **Websockets Support** slået til. Proxyen må ikke
pege på Sharedrive-containeren.

Firewall/NAT skal føre direkte til LiveKit-containeren:

- TCP `7881`
- UDP `3478`
- UDP `52000-52999`

## Trin 4: Test og aktivering

1. Åbn et eksisterende Room og test almindelig chat først.
2. Vælg **Deltag i tale** med to brugere og godkend mikrofonen.
3. Test begge veje, mute/unmute og forlad tale.
4. Test en gæst med og uden voice-tilladelse.

## Rollback

Hvis voice ikke virker, stoppes kun `sharedrive-livekit`, og LiveKit-proxyen
deaktiveres eller peges væk. Sharedrive, Rooms-chat, Files, Notes, PostgreSQL og
Redis fortsætter uden datarestore eller container-genskabelse.
