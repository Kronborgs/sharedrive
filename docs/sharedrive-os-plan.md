# Sharedrive OS — Plan: fra Docker-stack til selvstændig OS-box

Status: Udkast (2026-11-19) · Ejer: Kronborgs-lab · Repo: `sharedrive`

## 0. I dag

- Go-backend + React/TS-frontend i ét Docker-image (`sharedrive`), bygget af GitLab CI.
- Sidecar-tjenester: PostgreSQL 16, Redis 7, valgfri LiveKit + Gotenberg (kører i containeren).
- Drift: Unraid, volumes på `/mnt/user/...`, Cloudflare-tunnel, Watchtower til auto-update (opt-in).
- Secrets: `SESSION_SECRET`, `BACKUP_HMAC_SECRET`, `TOTP_ENCRYPT_KEY`, `DEVICE_TRUST_SECRET`,
  `POSTGRES_PASSWORD`, VAPID-nøgler, LiveKit-nøgler, SMTP (setup-vizen).

## 1. Mål

1. **Ét produkt = én boks.** Sharedrive OS leveres som bootbar ISO, der kan prøves live,
   sættes op grafisk/CLI og installeres permanent — uden at vide noget om Linux.
2. **Set-and-forget.** Boksen opdaterer OS og Sharedrive selv (apt-unattended-upgrades),
   overlever reboot, og ruller tilbage ved fejl. Ingen tilsyn.
3. **GitHub-forbliver-kilde.** Alt opdateres stadig fra `Kronborgs/sharedrive`
   (GitLab CI bygger, boksen trækker).
4. **Robust storage.** ZFS eller Btrfs på diske, som gerne må have forskellige
   størrelser; installerens layout skal vise brugbar kapacitet og advarsler før
   destruktive ændringer. Valgfri NVMe/SSD-cache kun når målinger/use-case viser
   nytte. Snapshots og kryptering; buddy-backup til en anden Sharedrive-boks.
5. **Bred driver-understøttelse.** 10GbE-NIC'er, SATA/SAS-controllers, iscsi/RAID —
   enten in-kernel eller med installer-støttet inddrivning.
6. **Secrets indbygget i installeren.** Genereres ved setup, gemmes krypteret i boksen,
   og kan sikres i koden (repo) via en bruger-ejet recovery-nøgle.

Ikke-mål (for nu): mobil-app, multi-tenant SaaS, cloud-distribution uden USB,
**cluster/delt disk mellem boks** (ikke et krav — redundans henses i stedet
af den eksisterende buddy-backup: krypteret backup mellem to Sharedrive-boks).

## 2. Afgrundsprælser (anbefalinger + alternativer)

| # | Spørgsmål | Anbefaling | Alternativ | Begrundelse |
|---|-----------|------------|------------|-------------|
| D1 | Basissystem | **Ubuntu Server 26.04 LTS** (support til 2031, ESM til 2036) | Debian 13, openSUSE | **Valgt af brugeren.** Bredt driver-dækning (Mellanox/Intel/Realtek 10GbE, SAS/RAID), `live-build`-økosystem, ZFS+Btrfs klar, apt |
| D2 | Storage | **Brugeren vælger mellem ZFS, Btrfs og Unraid-lignende disk-array** | — | Krav: diske må have forskellige størrelser. Installeren beregner kapacitet, redundans, parity-opdateringsmodel og trade-offs tydeligt; parity er valgfri |
| D3 | App-drift på boksen | **Native systemd + apt-deb** (ingen Docker) | Behold Docker-in-OS | Sharedrive pakkes til OS; Docker-udgaven forbliver til Unraid |
| D4 | Update-mekanik | **GitHub-releases + Ubuntu apt security updates**, med pre-update backup og health check | — | Sharedrive-version styres fra GitHub; Ubuntu 26.04 LTS modtager egne sikkerhedsopdateringer fra Ubuntus signerede arkiver |
| D5 | Live-ISO-bygge | **Ubuntu 26.04 LTS live-installationsmedie** (se arkitektur pr. platform) | — | AMD64/x86_64 og ARM64 kræver særskilte images/boot-support |
| D6 | Installer-UI | **Web-baseret installer** på LAN med lokal konsol fallback | TUI | Installeren må ikke kræve internet for at identificere eller sikkert vælge diske |
| D7 | Secrets-gemm | **Krypteret lokal state + brugeropbevaret offline recovery key** | — | Ingen produktionshemmeligheder i kildekode-repo eller CI |
| D8 | Secure Boot | **Understøttelse undersøges/testes pr. platform** | — | Undgå at slå Secure Boot fra som generel standard; signering og tredjepartsmoduler vurderes |
| D9 | Fjernadgang | **Cloudflare Tunnel indbygget/valgfri + direkte adgang via Nginx Proxy Manager (NPM)** | Bare LAN | NPM er reverse proxy til direkte adgang; Cloudflare Tunnel er separat valgfri adgangsvej. De skal kunne sameksistere uden port-/TLS-konflikter; installer skal tilbyde vejledning/integration, men ikke kræve NPM på samme boks |
| D10 | CPU-arkitekturer | **amd64 (x86_64) og arm64** | — | Første release skal definere understøttede boot-/hardwareprofiler; 32-bit x86 er ikke omfattet uden særskilt krav |

## 3. Mål-arkitektur

```
┌────────────────────────────── Sharedrive OS boks ─────────────────────────────┐
│                                                                                │
│  ISO/live  ──►  Ubuntu 26.04 LTS (HWE-kern) + openzfs + linux-firmware         │
│                  │                                                             │
│  Disk-layout:    │  pool/data   = RAID-Z1 (3+) eller mirror (2) eller single  │
│                  │  pool/state  = LUKS/ZFS-native-krypteret (DB, secrets, cfg)│
│                  │  L2ARC       = NVMe/SSD cache-disk (læsecache)             │
│                  │  SLOG (ZIL)  = samme NVMe (synk-skriver, crash-safe)       │
│                  │  /boot       = EFI + bootfs, separat (undgår disk-coupling)│
│                  │  backup/     = ekstern USB-disk (eksisterende backup-funk) │
│                  │                                                             │
│  Tjenester:     │  sharedrive (Go) · postgresql-16 · redis-7 · gotenberg       │
│                  │  cloudflared (opt) · wireguard (opt) · unattended-upgrades  │
│                  │  sharedrive-updater (apt-triger) · snapshots · node_exporter│
│                  └─────────────────────────────────────────────────────────────│
└────────────────────────────────────────────────────────────────────────────────┘
```

### Disk-layout-detaljer (ZFS)

| Datamængde | Pool | Indstilling |
|---|---|---|
| Filer (sharedrive-data) | `sd-data` | Disk-layout vælges efter diske og ønsket redundans; installer viser kapacitet baseret på mindste disk pr. ZFS vdev og brugerens valg |
| Cache (valgfri) | efter test | L2ARC = læsecache; SLOG = separat log til synkrone writes, ikke generel write-cache. Ikke aktiveret som standard |
| State (Postgres, secrets, cfg) | `sd-state` | Krypteret dataset/partition; backup og restore holdes adskilt fra OS |
| Backup | 2. Sharedrive-boks (buddy) | Eksisterende krypterede buddy-backup; supplerer, erstatter ikke lokal redundans |

### Disklayoutsvalg (ikke automatisk kun efter diskantal)

Installeren skal tilbyde mindst disse profiler og vise den præcise forventede brugbare
kapacitet før brugeren bekræfter:

1. **Ingen parity/redundans (JBOD/enkelt disk)** — enkelt disk eller flere diske
   hver for sig/udvidet volume, med tydelig advarsel om diskfejl.
2. **Standard software-RAID** — mirror/RAID10/RAID5/6 via understøttet Linux-løsning;
   anbefales kun når diskstørrelserne er ens eller passende partitionslayout er muligt.
   Forskellige størrelser kan give ubrugt plads og skal forklares før valg.
3. **Unraid-lignende array (valgfri parity-disk)** — mulighed for én eller flere
   parity-diske, hvor parity-diskens kapacitet skal være mindst lige så stor som
   største datadisk. Med diske i forskellige størrelser kan data-diskkapacitet
   udnyttes individuelt. Før implementation skal parity-teknologien vælges og
   dokumenteres: live parity (skriver med data) eller periodisk parity (fx
   SnapRAID-lignende model, hvor nye/ændrede data ikke er beskyttet før sync).
   Installer må aldrig markedsføre periodisk parity som realtidsbeskyttelse.
4. **ZFS/Btrfs** — valgfrie pool-/filesystem-profiler; ved ZFS skal brugerfladen
   vise vdev-regler og konsekvenser af diskstørrelser, ikke blot antal diske.

Der må ikke auto-formateres ud fra et gæt. Disk-identifikation og afsluttende
bekræftelse følger §4.2. Planen skal først beslutte hvilke profiler der er
prototype-/release-scope; Unraid-lignende parity er et særskilt teknisk spike før valg.


### Tjenestelag (systemd)

| Service | Kilde | Update |
|---|---|---|
| `sharedrive.service` (Go-bin + frontend statik) | deb `sharedrive` | apt |
| `postgresql-16.service` | apt (Ubuntu) | apt (unattended) |
| `redis-7.service` | apt (Ubuntu/openzfs-PPA) | apt |
| `gotenberg.service` | deb `sharedrive-gotenberg` | apt |
| `sharedrive-tunnel.service` (valgfri) | deb `sharedrive-tunnel` (cloudflared) | apt |
| `sharedrive-updater.service` | deb `sharedrive-os` (meta) | apt + timer |

## 4. Live-ISO og installer (core-feature)

### 4.1 Byggepipeline

- `os/` i samme GitHub-repo som Sharedrive-kilden. GitHub Actions er produktionspipeline;
  GitLab bruges kun til beta/validering.
- Separate amd64- og arm64-images/release assets; images inkluderer nødvendige boot-
  og firmwarekomponenter for den konkrete platformprofil.
- Release assets signeres, checksummes og publiceres til GitHub Releases; Ubuntu-pakker
  og sikkerhedsrettelser kommer fra Ubuntu officielle signerede apt-arkiver.

### 4.2 Installer-flow (skærm for skærm)

1. **Boot (USB)** → systemd → netværk (DHCP eller statisk) → installer-web på
   `http://<ip>/setup` (auto-opdagelse + QR i console).
2. **Hardware- og diskkontrol** (automatisk, før layoutvalg):
   - Vis alle diske med model, fuldt model/serial-id, serienummer, transport,
     størrelse og device path. Stable identity bruger `/dev/disk/by-id/`/WWN/serial;
     `/dev/sdX` vises kun som nuværende kernel-navn og må ikke være identiteten alene.
   - Vis identifikation i Unraid-stil, fx `TOSHIBA_MG10ACA20TE_<serial> (sdf)`;
     serial kan maskeres i fjern-UI, men skal kunne kontrolleres lokalt.
   - Brugeren markerer eksplicit OS-, data-, parity- og cache-diske. Installer
     afviser systemdisken, bootmediet, dublerede/ukendte serials og diske med
     eksisterende mount/filesystem, medmindre brugeren går gennem særskilt
     import/erase-flow.
   - Før sletning: vis hver valgt disk med præcis identitet + størrelse + rolle;
     kræv samlet ekstra bekræftelse (indtast fx `ERASE <kort serial>` pr disk).
   - Tilbyd først data-import/redningsmulighed: read-only scan/mount og tydelig
     eksport/backup-rådgivning. Ingen automatisk wipe ved install eller recovery.
3. **NIC- og controller-check**: `lspci -k`, firmware-status, NIC link/hastighed;
   hardware uden driver markeres, men må ikke føre til automatisk disk-/netværksændring.
4. **Storage-layoutvalg**: diskprofiler og kapacitetsberegning som beskrevet i §3;
   cache-disk foreslås, aldrig automatisk brugt.
5. **Kryptering**: LUKS/ZFS-native efter valgt layout; forklar boot/unlock-konsekvens.
6. **Netværk**: DHCP/statisk, hostname, domain.
7. **Admin-setup**: bruger + adgangskode, SMTP (testmail!), valgfri tunnel.
8. **Secrets-generering** (alt auto, ingen tomme felter):
   - `SESSION_SECRET`, `BACKUP_HMAC_SECRET`, `TOTP_ENCRYPT_KEY`, `DEVICE_TRUST_SECRET`,
     `POSTGRES_PASSWORD`, VAPID-pair, (LiveKit hvis valgt).
   - Gemmes lokalt krypteret; recovery bundle downloades, recovery key vises én gang.
9. **Recovery-nøgle-skærm**: bruger gemmer recovery key og bundle separat og
   bekræfter at de kan hente dem igen.
10. **Klar til**:
   - "Kør som live-demo" (ingen disk-skrivning, data forsvinder ved reboot)
   - "Installer til disk" (tydelig valgt-disk-oversigt + bekræftelse)
11. **Første boot efter install**: setup færdiggøres, backup/restore testes, admin
   får status og advarsel om at opbevare recovery-materiale sikkert.

### 4.3 Persistens-modeller

| Mode | Hvad der huskes |
|---|---|
| Live-demo (RAM) | Intet — lukkes ved reboot (med advarsel) |
| Live + persistence (valgfri USB-state) | Setup + secrets + data på valgt USB |
| Installeret (standard) | Alt på `sd-state` + `sd-data`, krypteret |
| Recovery | Ny live-boot → "Restore fra recovery bundle" (age-nøgle + bundle-fil) |

## 5. Secrets-håndtering (tabel)

| Secret | Genereres | Lokal lagring | Ekstern recovery |
|---|---|---|---|
| SESSION_SECRET | Installer | `/var/lib/sharedrive/secrets.env` (sd-state, 0600) | Kun inde i brugerens krypterede recovery bundle |
| BACKUP_HMAC_SECRET | Installer | samme | Kun inde i brugerens krypterede recovery bundle |
| TOTP_ENCRYPT_KEY | Installer | samme | Kun inde i brugerens krypterede recovery bundle |
| DEVICE_TRUST_SECRET | Installer | samme | Kun inde i brugerens krypterede recovery bundle |
| POSTGRES_PASSWORD | Installer | Postgres-config (sd-state) | Kun inde i brugerens krypterede recovery bundle |
| VAPID-pair | Installer | `/var/lib/sharedrive/vapid.json` | Kun inde i brugerens krypterede recovery bundle |
| LIVEKIT_* | Installer | systemd-override (sd-state) | Kun hvis tjenesten er konfigureret; krypteret recovery bundle |
| Cloudflare tunnel token | Bruger indsætter | `/var/lib/sharedrive/tunnel.env` | Kun hvis aktiveret; recovery bundle krypteret |
| LUKS/ZFS passphrase | Bruger | Ikke gemt på disk som klartekst | Brugerens offline kopi; separat fra bundle |
| Age recovery key | Installer/bruger | Aldrig på boksen | Offline bruger-kopi; aldrig repo/CI |

**Sikkerhedsregel:** Installerens hemmeligheder må ikke automatisk pushes til GitHub eller
repoet — heller ikke krypteret som standard. GitHub-konto/CI er ikke en passende
backup af brugerens master-nøgle. Installer opretter en krypteret recovery bundle,
og brugeren gemmer bundle og recovery key på adskilte, eksterne steder. CI har ingen
adgang til produktionshemmeligheder.

Repo-tilgang: Ingen produktionsnøgler eller recovery keys i repo eller CI. GitHub
indeholder kildekode, workflow-definitioner og signerede release-artefakter; boksen
henter Sharedrive-udgivelser herfra. Ubuntu 26.04 opdateres separat fra Ubuntus
officielle, signerede apt-arkiver. OS-opdateringer kan konfigureres til automatisk
installation af sikkerhedsrettelser, mens større versionsopgraderinger kræver en
kontrolleret release-/reboot-plan.

## 6. Update-mekanik (set-and-forget)

### 6.1 Opdateringsforløb og gendannelse før ændringer

Før enhver Sharedrive-opdatering (og OS-opdatering, der kræver reboot eller ændrer
storage/netværk):

1. Opret applikationskonsistent backup af Sharedrive-konfiguration og PostgreSQL;
   brug eksisterende backup-funktion hvor muligt, ellers implementér en særskilt
   pre-update export/pg_dump. Redis er cache/ephemeral efter nuværende Compose, så
   skal ikke behandles som autoritativ database uden at arkitekturen ændres.
2. Kontroller at backup er fuldført, ikke tom, kan læses, har version/schema-info,
   og at der er ledig plads. Fejl eller manglende destination stopper opdateringen.
3. Tag filesystem-snapshot (ZFS/Btrfs) af relevante system/config/data datasets.
4. Hent og verificer signerede Sharedrive-release-artefakter fra GitHub; verificer
   Ubuntu-pakker fra Ubuntus signerede arkiver.
5. Installer i kontrolleret rækkefølge; kør DB-migrationer og health checks.
6. Ved fejl: stop tjenesten, gendan kompatibel DB/config-backup og snapshot efter
   planlagt rollback. Vis resultat og behold logs; slet aldrig sidste kendte gode backup.

Dette skal fungere med offline/ekstern backup destination og buddy-backup, men
pre-update-gate skal kunne nægte opdateringen, hvis recovery ikke kan sikres.

**Vigtigt:** rollback af binærpakken alene er ikke nok, hvis migrationen har ændret
DB-schema eller data. Migrationer skal være backward-compatible hvor muligt;
ellers restore database + app i samme rollback-transaktion. Testen omfatter restore,
ikke blot at en backup-fil blev oprettet.

### 6.2 Sharedrive releases og Ubuntu-patching

- Kildekode og release-styring for Sharedrive ligger på GitHub-repoet
  `Kronborgs/sharedrive`. GitHub Actions bygger/tester multi-arch pakker og
  publicerer versionerede, checksum-verificerede og signerede release-artefakter.
- Publiceret Ubuntu apt-kilde er Ubuntus officielle signerede arkiver; Sharedrive
  release leveres separat via GitHub Releases. En public apt-repository kan vælges
  senere, men må ikke antages at GitHub Packages er et apt-repo.
- Ubuntu sikkerhedsrettelser følger Ubuntu 26.04 LTS apt-arkiver og policy; Sharedrive
  opdateres efter GitHub release-kanal. OS feature-upgrade og kernel reboot styres
  særskilt med maintenance window og rollback/restore gate.


### 6.3 Build- og releasepipeline (GitHub er produktionskilden)

```
GitHub Actions (source of truth)
  ├── tests/builds for amd64 + arm64
  ├── Docker multi-arch image (bevares til Unraid)
  ├── native Sharedrive packages + SBOM + signatures/checksums
  ├── release assets publiceret på GitHub Releases
  └── OS installer/ISO assets for de valgte hardwareprofiler
Ubuntu 26.04 official apt repositories
  └── OS security/kernel/firmware patches, separat fra Sharedrive release
```

- GitLab er beta/validering og må ikke være nødvendig for produktions-boksen.
- Før publicering kræves tests, underskrevet artefakt, checksums, release notes
  og en opdateringskanal (stable/beta) med mulighed for pause/rollback.
- GitHub Releases er release-filernes distribution; det er ikke i sig selv et
  apt-repo. Beslut senere om signeret apt-indeks på GitHub Pages eller at boksen
  henter/verificerer release-artefakter direkte. Prototype og test af signatur
  er en tidlig M1/M2-opgave.

### 6.4 Multi-arkitektur: amd64 + arm64 (krav)

**Krav af brugeren: boksen skal virke på så mange amd64- og arm64-systemer som
muligt** (samme dækning som det nuværende Docker-image).

| Del | amd64 | arm64 |
|---|---|---|
| Ubuntu 26.04 LTS + HWE-kern | ✅ | ✅ |
| ZFS (openzfs-pakke) | ✅ | ✅ |
| Btrfs | ✅ | ✅ |
| Go-backend (static build) | ✅ | ✅ |
| Postgres/Redis/Gotenberg (apt) | ✅ | ✅ |
| cloudflared | ✅ | ✅ |
| WireGuard (kernel + userspace) | ✅ | ✅ |
| 10GbE-NIC (Mellanox/Intel/Realtek) | ✅ | ⚠️ sjældnere fysisk — driver dækning er identisk, men test-matrix fokuserer på amd64 |

- **Deb-pakker**: `deb:build` kører i CI med matrix `GOARCH/ARCH ∈ {amd64, arm64}`
  → `sharedrive_*_amd64.deb` + `sharedrive_*_arm64.deb` i samme apt-repo
  (apt vælger automatisk korrekt arkitektur).
- **ISO**: `iso:build` bygger **2 ISO'er** (`sharedrive-os-v1.0-amd64.iso` og
  `-arm64.iso`) som GitHub Releases — en hybrid-ISO med begge kerner er
  teoretisk mulig, men 2 ISO'er er enklere at vedligeholde. (arm64-test kræver
  emuleret arm64-VM eller en fysisk arm64-maskine; M5 markerer arm64 som
  "emuleret/bevægelse" uden fysisk hardware.)
- **Firmware/NIC**: arm64-servere (fx Ampere/Graviton, Raspberry Pi CM4/CM5)
  har typisk andre NIC'er (fx Realtek/Intel i CM4/CM5) — `drivertest` dækker
  begge platforme, men test-matrixens fysiske dækning fokuserer på amd64.

## 7. Driver- og hardware-understøttelse

### 7.1 Kernel-dækning (Ubuntu HWE-kern, 6.x)

| Kategori | Drivere (in-kernel) | Status |
|---|---|---|
| 10GbE Mellanox (ConnectX) | `mlx5_core` | ✅ **mål-chip** |
| 10GbE Intel X550/X710 | `ixgbe` | ✅ **mål-chip** |
| 10GbE Intel E810/i210 | `iavf` / `igb` | ✅ **mål-chip** |
| 10GbE Realtek | `r8169` | ✅ **mål-chip** (firmware!) |
| 10GbE QLogic (QLE) | `bnx2x` | ✅ bonus |
| SATA-controllers | `ahci`, `libahci` | ✅ |
| SAS (Broadcom LSI) | `mpt3sas`, `megaraid_sas` | ✅ |
| SAS (Microsemi) | `mpt2sas` | ✅ |
| RAID-controllers (LSI/MegaRAID) | `megasas`, `megaraid_sas` | ✅ |
| iSCSI | `iser`, `libiscsi` | ✅ |
| NVMe | `nvme`, `nvme-fabrics` | ✅ |
| Mikrokode (Intel/AMD) | `microcode-linux`, `iucode-tool` | ✅ (package) |
| Firmware (Wi-Fi/BT) | `linux-firmware` | ✅ (package) |

### 7.2 "Driver test"-verktøj i installer

`sharedrive-drivertest` (CLI, køres automatisk i installer + tilgængelig i boksen):
- `lspci -k` → kort for kort: driver indlæst? version?
- `ethtool -i <if>` + `ethtool <if> | grep Speed` → link-hastighed
- `dmesg | grep -iE 'firmware|microcode'` → mangler firmware?
- `lsblk -o NAME,MODEL,SIZE,ROTA,TRAN` → disk-overblik
- Output: `OK / WARNING / FAIL` pr enhed + fejl-melding + evt. pakke-forslag
  (fx `apt install linux-firmware` / DKMS-pakke / "kontakt os").

### 7.3 Ekstra-drev (edge-cases)

- **DKMS-ordning**: `os/drivers/` i repo med DKMS-pakker til uheldige kort
  (fx exotiske 10GbE Realtek/Intel iO). Installer kan `dkms install` ved behov.
- **Out-of-tree kernel-module** (fx `zfio` til visse RAID-kards) —
  dokumenteret i `docs/drivers/`, ikke auto-installeret (for risiko).
- **Firmware-udpak**: `linux-firmware` + valgfri `linux-firmware-nonfree`
  (installer spørger ved manglende firmware).

### 7.4 Test-matrix (mål: mindst én fysisk boks pr kategori)

| Konfiguration | Dækning |
|---|---|
| 1× NVMe + 1× SATA, 10GbE Realtek | Baseline + r8169-firmware |
| 2× SATA mirror (ZFS) + NVMe cache | ZFS mirror + L2ARC/SLOG |
| 2× SATA (Btrfs) | Btrfs-stien i installeren |
| 3× SATA raidz1 + SAS HBA (LSI) | RAID-Z1 + mpt3sas |
| 10GbE Mellanox | mlx5_core + link-verifikation |
| 10GbE Intel X550 + WireGuard | ixgbe + WG-tunnel |
| USB-boot + USB-persistence | Live-scenarier |

## 8. Set-and-forget-hardening (checklist)

- [ ] `unattended-upgrades` + auto-reboot window (konfigurerbar via dashboard)
- [ ] ZFS-snapshots (beholdningspolitisk) + `zfs send/receive` til USB
- [ ] Health-endpoint (eksisterende) + `systemd` watchdog + `node_exporter`
- [ ] Log-shipping: `journald` → valgfri remote syslog / Cloudflare Logpush
- [ ] Auto-rollback ved update-fejl (health-check + ZFS-rollback)
- [ ] `apt hold`-liste for kritiske pakker (postgres, zfs, sharedrive) ved store jumps
- [ ] `fail2ban` (SSH, web) + `ufw` default-deny (kun 80/443/5432-intern/SSH-tunnel)
- [ ] SSH: key-only + valgfri (port 22 lukket standard, adgang via tunnel)
- [ ] NTP (systemd-timesyncd) + `tzdata` (Europe/Copenhagen default)
- [ ] `sharedrive-updater` service: health-check + auto-rollback + log-til-admin
- [ ] "Recovery mode" i live-ISO: restore fra backup, reset passwords, re-enroll
- [ ] Disk-failover-advarsel: `zpool status` i dashboard + e-mail ved degradation
- [ ] Boot-fallback: GRUB "last known good" + ZFS-boot (efi + zfs-bootloader)

## 9. Repo-struktur (forslag: ét repo, ny `os/`-stamme)

```
sharedrive/
├── backend/            (uændret)
├── frontend/           (uændret)
├── docker-compose.yml  (uændret — Unraid-udbud)
├── os/                 (NYT)
│   ├── live/           # live-build config
│   │   ├── config/     # live-build chroot + packages
│   │   ├── includes/   # installer-bin, systemd units, scripts
│   │   └── scripts/    # build-ISO.sh, sign.sh
│   ├── packages/       # deb-bygge (Dockerfile for dpkg, systemd units)
│   │   ├── sharedrive/         # meta: Go-bin + frontend + units
│   │   ├── sharedrive-gotenberg/
│   │   ├── sharedrive-tunnel/
│   │   └── sharedrive-os/      # meta-pakke: zfs, apt-repo, unattended
│   ├── installer/      # web-installer (React eller Go+HTML)
│   ├── secrets/        # schema/docs only; no production secrets or CI recovery key
│   └── drivers/        # DKMS-pakker, driver-test script
├── docs/
│   ├── sharedrive-os-plan.md  (DENNE FIL)
│   ├── drivers/               # driver-matrix + guides
│   └── OPERATIONS.md          # day-2: rollback, recovery, disk-swap
└── .gitlab-ci.yml      (forlænges med deb:build, apt:publish, iso:build)
```

## 10. Milestones (med acceptance-criteria)

| M | Navn | Leverancer | Accept |
|---|------|------------|--------|
| **M0** | Beslutninger + risikospikes | Parity-spike, restore-format, GitHub release-signing, first hardware profiles | Acceptance tests and support scope written; no physical disk inventory required |
| **M1** | Native package prototype | `os/install.sh` + Sharedrive package on Ubuntu 26.04; backup-before-update proof | Install/update/restore works on test VM; Docker path remains intact |
| **M2** | Release pipeline | GitHub Actions multi-arch builds, signed releases, update channel | Signature verification and rollback tested on amd64 + arm64 emulation/device |
| **M3** | Installer v1 | Live install, stable disk IDs, profiles + destructive-action confirmation | No disk wipe without explicit per-disk confirmation; data import path documented |
| **M4** | Secrets + recovery | Encrypted recovery bundle, offline key process, restore tests | Fresh system restore verified; no secrets in repo/CI |
| **M5** | Hardware matrix | NIC/storage driver checks for Mellanox/Intel/Realtek + SATA/SAS, amd64/arm64 profiles | Verified hardware list published; unsupported hardware clearly reported |
| **M6** | Set-and-forget release | Ubuntu security updates + Sharedrive stable channel, pre-update backups, recovery gate | Simulated failed update restores DB/config and service; reboot/update policy documented |

Rækkefølge: M0 → M1 → M2 → M3 → M4 → M5 → M6 (M4 kan paralleliseres med M3).
Omtrentlig besigtigelse: M1-M2 2-3 uger, M3-M4 3-4 uger, M5 2 uger, M6 1-2 uger.

## 11. Risici og mitigation

| Risiko | Sandsynlighed | Impact | Mitigation |
|---|---|---|---|
| ZFS + Secure Boot (MOK) | Medium | Boot fejler | Secure Boot OFF i leverandtilstand (D8); MOK-signering som M5+ |
| 1 disk = ingen redundancy | Høj | Data-tab | Installer VARSLE TYDELIGT + anbefal 2+ disk; Btrfs-fallback |
| Driver-mangle (exotisk NIC) | Lav | Ingen netværk | `drivertest` + DKMS-ordning + "bring USB-ethernet" i docs |
| Update brækker app | Medium | Boks down | ZFS-snapshot + auto-rollback + apt hold + health-gate |
| live-build vedligeholdelse | Medium | ISO forældes | CI bygger ISO ved hver release (tag), ikke ad hoc |
| Secrets-tab (recovery-nøgle) | Lav | Full data-tab | **Ingen** — brugeren EJR nøglen; dokumenteret + QR + fil |
| Ubuntu-LTS-afhængighed | Lav | Support-slut 2031 (ESM 2036) | 5-årigt horisont + ESM; Debian-13-fallback dokumenteret |

## 12. Beslutninger og åbne M0-spørgsmål

Afklaret af brugeren:

1. Ubuntu 26.04 LTS som OS-base; Ubuntu security patches kommer fra Ubuntus officielle arkiver.
2. Sharedrive produktion/versionering styres fra GitHub `Kronborgs/sharedrive`; GitLab er beta. Docker multi-arch forbliver til Unraid.
3. Målplatforme er amd64/x86_64 og arm64; bred støtte er målet, med konkrete boot-/hardwareprofiler dokumenteret efter test.
4. Storage skal håndtere diske af forskellige størrelser. Brugeren vælger mellem ZFS, Btrfs, klassisk software-RAID og mulig Unraid-lignende parity; parity er valgfri, og valg afhænger ikke kun af diskantal.
5. Diskidentifikation skal vise fuldt model + serienummer/stabil ID og aktuelt `/dev/...`-navn (fx `TOSHIBA_MG10ACA20TE_<serial> (sdf)`). Ingen sletning uden præcis oversigt og eksplicit bekræftelse.
6. Før opdatering skal Sharedrive-config og PostgreSQL sikkerhedskopieres og kontrolleres; ved fejl må opdateringen ikke fortsætte. Restore og rollback skal testes.
7. Cloudflare Tunnel skal være indbygget/valgfri; direkte adgang via Nginx Proxy Manager (NPM) er bekræftet. De to adgangsveje skal kunne sameksistere uden port-/TLS-konflikter.
8. Buddy-backup til en anden Sharedrive-boks dækker box-to-box backup; cluster/delt disk er ikke krav.
9. Produktionshemmeligheder og recovery key må ikke ligge i repo eller CI.

M0 før implementation:

- Teknisk spike og valg af parity-adfærd (realtid eller periodisk), storage-profiler,
  kapacitetsberegning og recovery-advarsler.
- Test GitHub release distribution/signaturverifikation; afgør release assets direkte
  eller signeret apt-indeks.
- Afgræns første arm64-bootprofiler og x86_64-testmål; udvid efter validering.
- Definér pre-update backup-format, restore-procedure, migrationsregler og rollback-test.


