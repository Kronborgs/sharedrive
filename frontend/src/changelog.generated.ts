export type ChangelogEntry = {
  hash: string
  date: string
  message: string
}

export const CHANGELOG_ENTRIES: ChangelogEntry[] = [
  { hash: '8c6e96d', date: '05.07.2026', message: "ci(gitlab): publish sharedrive image as latest" },
  { hash: 'ea48162', date: '05.07.2026', message: "ci(gitlab): add backend and frontend pipeline" },
  { hash: '1a9dbfb', date: '05.07.2026', message: "chore: add remaining local pipeline support files" },
  { hash: '66fe97f', date: '05.07.2026', message: "chore(workspace): tighten local terminal auto-approve rules" },
  { hash: 'a69e495', date: '05.07.2026', message: "feat(settings): add SMTP provider presets in admin UI" },
  { hash: 'a1d3c5d', date: '13.06.2026', message: "backup: add live push progress bar (speed + ETA)" },
  { hash: '5a931a5', date: '13.06.2026', message: "chore: bump version to 1.2.6" },
  { hash: 'e861e66', date: '13.06.2026', message: "backup: fix goroutine leak in streamBody; add pre-attempt push logs" },
  { hash: '8056213', date: '13.06.2026', message: "backup: remove unused bytes import" },
  { hash: 'e6d4163', date: '13.06.2026', message: "backup: stream multipart body via pipe (no memory buffer); fix tunnel fallthrough" },
  { hash: 'e53f3d5', date: '13.06.2026', message: "backup: reset stuck push_in_progress on startup; add manual reset button in UI" },
  { hash: 'a29f73f', date: '13.06.2026', message: "backup: exclude buddy/receive from global 4MB body limit ÔÇö fixes invalid multipart form" },
  { hash: '703dc34', date: '13.06.2026', message: "backup: fix sender-archives using tertiaryEnabled guard instead of buddyEnabled" },
  { hash: '8379701', date: '13.06.2026', message: "backup: log ParseMultipartForm error details for debugging" },
  { hash: 'c20c998', date: '13.06.2026', message: "backup: set Content-Length on buddy push requests ÔÇö fixes multipart parse error through tunnel" },
  { hash: 'ae741f3', date: '13.06.2026', message: "backup: tunnel transport errors fall through to direct upload; refactor buildBody" },
  { hash: 'a16422a', date: '13.06.2026', message: "backup: add diagnostic logging to buddy push URL selection" },
  { hash: 'f616885', date: '13.06.2026', message: "backup: use outgoing tunnel for push ÔÇö bypasses Cloudflare 413 without needing peer to reconnect" },
  { hash: 'fb40e0b', date: '13.06.2026', message: "backup: show push error detail + 413 hint, tunnel direction warning; fix FolderSize retry on 404" },
  { hash: 'a5e94aa', date: '13.06.2026', message: "backup: improve folder picker UX ÔÇö inherited selection, exclude subfolders, scrollable list" },
]