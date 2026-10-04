# Rooms architecture and operations

Rooms is Sharedrive's self-hosted collaboration workspace. It reuses the
existing Sharedrive users, groups, files, Notes, storage, audit log and SMTP
configuration. Rooms does not create a second storage, identity or permission
system.

## Security model

- Room membership is enforced by the backend for every Room API and WebSocket
  action. A Sharedrive administrator can moderate messages globally, but is not
  automatically a member of a Room and gains no access to shared files or
  Notes merely by being an administrator.
- Chat is stored in PostgreSQL. When `ROOMS_ENCRYPT_KEY` is configured, message
  bodies are encrypted at rest. Keep this key when moving or restoring an
  installation; a replacement key cannot decrypt existing chat history.
- HTTPS/WSS protects browser traffic. The application CSP permits only the
  configured LiveKit origin and the same-origin Rooms WebSocket endpoint.
- Camera, microphone and screen capture are requested only after an explicit
  Rooms meeting action. Camera remains off until the participant chooses
  **Start camera**; it is not requested while opening a Room or joining as a
  listener.
- Guest links are time-limited and can be revoked. Raw invitation and guest
  session tokens are never logged or written to a backup.

## Backup and restore

The setting **Admin → Settings → Rooms → Include Rooms in backup** controls
whether a new admin backup includes Rooms.

When enabled, the HMAC-signed admin archive includes Rooms, managed-group
membership, messages, reactions, read state and File/Note reference records.
Sharedrive files and Notes retain their normal IDs, ownership, quota and
retention rules; Rooms backs up only the reference to them.

Guest-authored history is retained, but guest access is deliberately invalidated
on restore:

- guest invitation records are restored as revoked;
- guest-session login hashes are replaced with unusable values and sessions are
  restored as revoked;
- Room owners create new guest links after a restore.

This prevents an old URL, cookie or browser session from gaining access after a
restore. A backup that does not include Rooms is refused when restoring into an
installation that already contains Rooms. Take and verify a current backup
before upgrades or a restore operation.

## Optional LiveKit voice, video and screen sharing

Voice, video and screen sharing are optional. Files, Notes, chat and login work when
LiveKit is absent, disabled or temporarily unavailable.

1. Create distinct `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` values. Set both
   in Sharedrive and configure the same key-to-secret mapping under `keys:` in
   LiveKit's `config.yaml`.
2. Set `LIVEKIT_URL` to the public secure endpoint, for example
   `wss://livekit.example.com`. It is not the same value as `APP_BASE_URL`.
3. Put `livekit.example.com` behind a WebSocket-capable HTTPS reverse proxy to
   LiveKit's own port `7880`, never to the Sharedrive container.
4. Open only the LiveKit ports you configure: WebRTC TCP `7881`, the configured
   UDP ICE range, and optional TURN UDP `3478` or TURN/TLS. Do not expose the
   Sharedrive API or the LiveKit secret to browsers.
5. Restart the affected services after key/configuration changes, then enable
   **Voice in Rooms** in Sharedrive.

### Media permissions

- **Microphone:** enabled only after joining voice.
- **Camera:** enabled only after pressing **Start camera**. Stopping camera
  unpublishes the camera track without leaving the meeting.
- **Screen sharing:** enabled only after choosing **Share screen** and is
  separate from camera.
- **Guests:** still require their existing voice permission; screen sharing
  additionally requires the invitation's screen-share permission.

### Screenshot placeholders

Store committed documentation screenshots under `docs/images/rooms/`:

```text
rooms-workspace.png
rooms-meeting.png
rooms-video.png
```

Reference them in release notes or this document after the files exist. The
placeholders intentionally do not reference missing image files.

For current port, TURN/TLS and NAT guidance, consult the official
[LiveKit ports and firewall documentation](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
and [self-hosted deployment guide](https://docs.livekit.io/transport/self-hosting/deployment/).

## Troubleshooting

- **Invalid API key:** the text to the left of `keys:` in `config.yaml` must
  exactly equal `LIVEKIT_API_KEY`; its value must exactly equal
  `LIVEKIT_API_SECRET`.
- **Signal connection fails:** verify public DNS, trusted HTTPS/WSS, reverse
  proxy WebSocket support and that `LIVEKIT_URL` uses the LiveKit hostname.
- **One participant cannot hear or see a shared screen:** check the UDP range,
  TCP 7881, NAT/external-IP configuration and optional TURN configuration.
- **Restored chat cannot be read:** use the original `ROOMS_ENCRYPT_KEY`.

## Admin access and notifications

The admin Rooms access view is the operational overview for Rooms-related access. It shows:

- Sharedrive and Rooms-enabled accounts, account type, access state, and Room count.
- Pending Room member invitations with Room, role, expiry, and revoke action.
- Active guest sessions with Room, invitation label, expiry, last activity, and revoke action.
- Group membership management for adding and removing Sharedrive users.

The central admin Users view also exposes product access for Files, Rooms, Notes, and Music. The stored levels are `none`, `limited`, and `full`; the backend blocks disabled products while resource-level sharing and Room membership checks remain separate.

Chat notification delivery is controlled per user. It is enabled by default, can be disabled by an administrator, and is checked by both unread chat email digests and generic Rooms Web Push delivery. Push content remains privacy-preserving: it does not reveal message text, sender, or conversation name on the lock screen.

## Mobile PWA player and navigation

The compact mobile music player remains fixed below the application header so playback controls are available while navigating. Its stacking order is below the mobile sidebar overlay and sidebar, which keeps Notes, My Files, and the other navigation links usable when the menu is opened. Media Session and lock-screen playback behavior are unchanged.

## Collaborative Office files in Chat

Rooms resources reuse the existing Sharedrive file model. When an authorized
participant opens a supported Word, spreadsheet, or presentation file from a
Room, direct conversation, or group conversation, the file opens in the
configured OnlyOffice Document Server.

OnlyOffice support is controlled in Admin → System Settings. The supported
formats are:

- Word: DOC, DOCX, DOCM, DOT, DOTX, RTF, ODT, OTT
- Spreadsheets: XLS, XLSX, XLSM, XLSB, XLTX, CSV, ODS, OTS
- Presentations: PPT, PPTX, PPTM, POTX, ODP, OTP

The existing Sharedrive authorization remains authoritative. Room membership or
a chat resource reference does not grant file access by itself. Only users who
can already access the file can open and edit it. Changes are written back
through the OnlyOffice callback; images, PDFs, and unsupported formats continue
to use the normal file preview.