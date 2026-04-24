import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

export type Locale = 'da' | 'en'

// ─── Translation dictionary ──────────────────────────────────────────────────

const translations = {
  // ── Navigation ────────────────────────────────────────────────────────────
  'nav.myFiles':       { da: 'Mine filer',       en: 'My Files' },
  'nav.shared':        { da: 'Delt',             en: 'Shared' },
  'nav.recent':        { da: 'Seneste',          en: 'Recent' },
  'nav.activity':      { da: 'Aktivitet',        en: 'Activity' },
  'nav.trash':         { da: 'Papirkurv',        en: 'Trash' },
  'nav.backup':        { da: 'Backup',           en: 'Backup' },

  // ── Search ────────────────────────────────────────────────────────────────
  'search.placeholder':{ da: 'Søg filer…',       en: 'Search files…' },
  'search.noResults':  { da: 'Ingen resultater', en: 'No results' },
  'search.myFiles':    { da: 'Mine filer',       en: 'My files' },
  'search.sharedWith': { da: 'Delt med mig',     en: 'Shared with me' },

  // ── Admin nav ─────────────────────────────────────────────────────────────
  'nav.dashboard':     { da: 'Dashboard',        en: 'Dashboard' },
  'nav.users':         { da: 'Brugere',          en: 'Users' },
  'nav.auditLog':      { da: 'Revisionslog',     en: 'Audit Log' },
  'nav.blockedIps':    { da: 'Blokerede IP\'er', en: 'Blocked IPs' },
  'nav.tags':          { da: 'Tags',             en: 'Tags' },
  'nav.storage':       { da: 'Lager',            en: 'Storage' },
  'nav.settings':      { da: 'Indstillinger',    en: 'Settings' },

  // ── Common actions ────────────────────────────────────────────────────────
  'action.upload':     { da: 'Upload',           en: 'Upload' },
  'action.download':   { da: 'Download',         en: 'Download' },
  'action.delete':     { da: 'Slet',             en: 'Delete' },
  'action.rename':     { da: 'Omdøb',            en: 'Rename' },
  'action.move':       { da: 'Flyt',             en: 'Move' },
  'action.copy':       { da: 'Kopiér',           en: 'Copy' },
  'action.share':      { da: 'Del',              en: 'Share' },
  'action.cancel':     { da: 'Annullér',         en: 'Cancel' },
  'action.save':       { da: 'Gem',              en: 'Save' },
  'action.open':       { da: 'Åbn',              en: 'Open' },
  'action.close':      { da: 'Luk',              en: 'Close' },
  'action.newFolder':  { da: 'Ny mappe',         en: 'New folder' },
  'action.newDoc':     { da: 'Nyt dokument',     en: 'New document' },
  'action.signOut':    { da: 'Log ud',           en: 'Sign out' },
  'action.saveChanges':{ da: 'Gem ændringer',    en: 'Save changes' },
  'action.emptyTrash': { da: 'Tøm papirkurv',   en: 'Empty trash' },
  'action.restore':    { da: 'Gendan',           en: 'Restore' },
  'action.clearSelection': { da: 'Ryd valg',     en: 'Clear selection' },
  'action.moreActions':{ da: 'Flere handlinger', en: 'More actions' },

  // ── File types (new document dropdown) ────────────────────────────────────
  'doc.word':          { da: 'Word (.docx)',      en: 'Word (.docx)' },
  'doc.excel':         { da: 'Excel (.xlsx)',     en: 'Excel (.xlsx)' },
  'doc.powerpoint':    { da: 'PowerPoint (.pptx)',en: 'PowerPoint (.pptx)' },
  'doc.wordName':      { da: 'Nyt dokument',     en: 'New document' },
  'doc.excelName':     { da: 'Nyt regneark',     en: 'New spreadsheet' },
  'doc.powerpointName':{ da: 'Ny præsentation',  en: 'New presentation' },
  'doc.textFile':      { da: 'Tekstfil (.txt)',   en: 'Text file (.txt)' },
  'doc.textFileName':  { da: 'Ny tekstfil',       en: 'New text file' },
  'doc.markdown':      { da: 'Markdown (.md)',     en: 'Markdown (.md)' },
  'doc.markdownName':  { da: 'Ny markdown',        en: 'New markdown' },
  'doc.jsonFile':      { da: 'JSON (.json)',       en: 'JSON (.json)' },
  'doc.jsonFileName':  { da: 'Ny JSON-fil',        en: 'New JSON file' },

  // ── Pages ─────────────────────────────────────────────────────────────────
  'page.myFiles':      { da: 'Mine filer',       en: 'My Files' },
  'page.shared':       { da: 'Delt med mig',     en: 'Shared with me' },
  'page.recent':       { da: 'Seneste',          en: 'Recent' },
  'page.activity':     { da: 'Aktivitet',        en: 'Activity' },
  'page.trash':        { da: 'Papirkurv',        en: 'Trash' },
  'page.admin':        { da: 'Admin Dashboard',  en: 'Admin Dashboard' },
  'page.home':         { da: 'Hjem',             en: 'Home' },

  // ── File operations ───────────────────────────────────────────────────────
  'files.selected':    { da: 'valgt',            en: 'selected' },
  'files.shareFolder': { da: 'Del mappe',        en: 'Share folder' },
  'files.renameFolder':{ da: 'Omdøb mappe',      en: 'Rename folder' },
  'files.deleteFolder':{ da: 'Slet mappe',       en: 'Delete folder' },
  'files.listView':    { da: 'Listevisning',     en: 'List view' },
  'files.gridView':    { da: 'Gittervisning',    en: 'Grid view' },
  'files.loading':     { da: 'Indlæser…',        en: 'Loading…' },
  'files.noActivity':  { da: 'Ingen aktivitet endnu', en: 'No activity yet' },
  'files.nothingShared':{ da: 'Intet er blevet delt med dig endnu.', en: 'Nothing has been shared with you yet.' },
  'files.emptyFolder': { da: 'Denne mappe er tom', en: 'This folder is empty' },
  'files.playlist':    { da: 'Afspilningsliste', en: 'Playlist' },
  'files.addToPlaylist':{ da: 'Tilføj til playlist', en: 'Add to playlist' },
  'files.addToQueue':  { da: 'Tilføj til kø',    en: 'Add to queue' },

  // ── Confirm dialogs ──────────────────────────────────────────────────────
  'confirm.trash':     { da: 'Flytte til papirkurven?', en: 'Move to trash?' },
  'confirm.trashItems':{ da: 'Mapper flyttes inklusiv indhold.', en: 'Folders will be moved including their contents.' },
  'confirm.emptyTrash':{ da: 'Slet permanent alle elementer i papirkurven?', en: 'Permanently delete all items in trash?' },
  'confirm.deleteForever': { da: 'Slet permanent?', en: 'Delete permanently?' },

  // ── Toasts / messages ────────────────────────────────────────────────────
  'toast.moved':       { da: 'Flyttet',          en: 'Moved' },
  'toast.moveFailed':  { da: 'Flytning fejlede', en: 'Move failed' },
  'toast.deleted':     { da: 'Slettet',          en: 'Deleted' },
  'toast.deleteFailed':{ da: 'Sletning fejlede', en: 'Delete failed' },
  'toast.restored':    { da: 'Gendannet',        en: 'Restored' },
  'toast.restoreFailed':{ da: 'Gendannelse fejlede', en: 'Restore failed' },
  'toast.emptyTrashFailed':{ da: 'Papirkurv kunne ikke tømmes', en: 'Empty trash failed' },
  'toast.duplicated':  { da: 'Duplikeret',       en: 'Duplicated' },
  'toast.createFolderFailed':{ da: 'Kunne ikke oprette mappe', en: 'Failed to create folder' },
  'toast.createDocFailed':{ da: 'Kunne ikke oprette dokument', en: 'Failed to create document' },
  'toast.noAudioFiles':{ da: 'Ingen lydfiler fundet i denne mappe', en: 'No audio files found in this folder' },
  'toast.playlistFull':{ da: 'Playlisten er fuld (max 50)', en: 'Playlist is full (max 50)' },
  'toast.couldNotReadFolder':{ da: 'Kunne ikke læse mappeindhold', en: 'Could not read folder contents' },
  'toast.playlistUpdated':{ da: 'Playlist opdateret', en: 'Playlist updated' },
  'toast.itemsCouldNotTrash':{ da: 'element(er) kunne ikke flyttes til papirkurven', en: 'item(s) could not be moved to trash' },
  'toast.itemsCouldNotMove':{ da: 'element(er) kunne ikke flyttes', en: 'item(s) could not be moved' },

  // ── Playlist dialog ───────────────────────────────────────────────────────
  'playlist.addToPlaylist':{ da: 'Tilføj til playlist', en: 'Add to playlist' },
  'playlist.first50':  { da: 'Første 50 numre',  en: 'First 50 tracks' },
  'playlist.random50': { da: 'Vælg 50 tilfældigt', en: 'Pick 50 randomly' },

  // ── Music player ─────────────────────────────────────────────────────────
  'player.previous':   { da: 'Forrige',          en: 'Previous' },
  'player.play':       { da: 'Afspil',           en: 'Play' },
  'player.pause':      { da: 'Pause',            en: 'Pause' },
  'player.next':       { da: 'Næste',            en: 'Next' },
  'player.shuffleOn':  { da: 'Shuffle til',      en: 'Shuffle on' },
  'player.shuffleOff': { da: 'Shuffle fra',      en: 'Shuffle off' },
  'player.showList':   { da: 'Vis liste',        en: 'Show list' },
  'player.hideList':   { da: 'Skjul liste',      en: 'Hide list' },
  'player.closePlayer':{ da: 'Luk afspiller',    en: 'Close player' },
  'player.removeTrack':{ da: 'Fjern fra playlist', en: 'Remove from playlist' },
  'player.volume':     { da: 'Lydstyrke',        en: 'Volume' },
  'player.empty':      { da: 'Playlist tom',     en: 'Playlist empty' },
  'player.addMusic':   { da: 'Tilføj musik',     en: 'Add music' },
  'player.addSelected':{ da: 'Tilføj valgte',    en: 'Add selected' },
  'player.createAndAdd':{ da: 'Opret og afspil', en: 'Create & play' },
  'player.audioOnly':  { da: 'Kun lydfiler',     en: 'Audio files only' },
  'player.noAudio':    { da: 'Ingen lydfiler i denne mappe', en: 'No audio files in this folder' },

  // ── OnlyOffice editor ────────────────────────────────────────────────────
  'oo.backToFolder':   { da: 'Tilbage til mappen', en: 'Back to folder' },
  'oo.closeEditor':    { da: 'Luk editor',       en: 'Close editor' },
  'oo.loadFailed':     { da: 'Kunne ikke indlæse editor-konfiguration.', en: 'Could not load editor configuration.' },

  // ── Auth ──────────────────────────────────────────────────────────────────
  'auth.2faEnabled':   { da: '2FA aktiveret',    en: '2FA enabled' },
  'auth.enable2fa':    { da: 'Aktivér 2FA',      en: 'Enable 2FA' },

  // ── Trash ─────────────────────────────────────────────────────────────────
  'trash.autoDelete':  { da: 'Elementer i papirkurven slettes automatisk efter {days} dage.', en: 'Items in trash are automatically deleted after {days} days.' },

  // ── Activity page ─────────────────────────────────────────────────────────
  'activity.uploaded':    { da: 'Uploaded',       en: 'Uploaded' },
  'activity.downloaded':  { da: 'Downloaded',     en: 'Downloaded' },
  'activity.previewed':   { da: 'Vist',           en: 'Previewed' },
  'activity.downloadedZip':{ da: 'Downloaded ZIP', en: 'Downloaded ZIP' },
  'activity.deleted':     { da: 'Slettet',        en: 'Deleted' },
  'activity.restored':    { da: 'Gendannet',      en: 'Restored' },
  'activity.moved':       { da: 'Flyttet',        en: 'Moved' },
  'activity.renamed':     { da: 'Omdøbt',         en: 'Renamed' },
  'activity.createdFolder':{ da: 'Oprettet mappe', en: 'Created folder' },
  'activity.action':      { da: 'Handling',       en: 'Action' },
  'activity.file':        { da: 'Fil',            en: 'File' },
  'activity.ip':          { da: 'IP',             en: 'IP' },
  'activity.when':        { da: 'Hvornår',        en: 'When' },

  // ── Admin dashboard ───────────────────────────────────────────────────────
  'admin.overview':       { da: 'Oversigt',       en: 'Overview' },
  'admin.recentActivity': { da: 'Seneste aktivitet', en: 'Recent Activity' },
  'admin.totalUsers':     { da: 'Brugere i alt',  en: 'Total Users' },
  'admin.activeUsers':    { da: 'Aktive brugere', en: 'Active Users' },
  'admin.diskUsed':       { da: 'Disk brugt',     en: 'Disk Used' },
  'admin.diskCapacity':   { da: 'Disk kapacitet', en: 'Disk Capacity' },
  'admin.diskUsage':      { da: 'Diskforbrug (hele volumen)', en: 'Disk usage (entire volume)' },
  'admin.logins30d':      { da: 'Logins (30d)',   en: 'Logins (30d)' },
  'admin.failedLogins30d':{ da: 'Fejlede logins (30d)', en: 'Failed logins (30d)' },
  'admin.uploads30d':     { da: 'Uploads (30d)',  en: 'Uploads (30d)' },
  'admin.downloads30d':   { da: 'Downloads (30d)', en: 'Downloads (30d)' },
  'admin.lockouts30d':    { da: 'Lockouts (30d)', en: 'Lockouts (30d)' },
  'admin.liveBandwidth':  { da: 'Live båndbredde', en: 'Live Bandwidth' },
  'admin.noTransfers':    { da: 'Ingen aktive overførsler', en: 'No active transfers' },
  'admin.system':         { da: 'System',         en: 'System' },

  // ── Context menu ──────────────────────────────────────────────────────────
  'ctx.open':          { da: 'Åbn',              en: 'Open' },
  'ctx.download':      { da: 'Download',         en: 'Download' },
  'ctx.share':         { da: 'Del',              en: 'Share' },
  'ctx.rename':        { da: 'Omdøb',            en: 'Rename' },
  'ctx.move':          { da: 'Flyt',             en: 'Move' },
  'ctx.copy':          { da: 'Kopiér',           en: 'Copy' },
  'ctx.trash':         { da: 'Flyt til papirkurv', en: 'Move to trash' },
  'ctx.delete':        { da: 'Slet permanent',   en: 'Delete permanently' },
  'ctx.restore':       { da: 'Gendan',           en: 'Restore' },
  'ctx.backup':        { da: 'Tilføj til backup', en: 'Add to backup' },
  'ctx.addToPlaylist': { da: 'Tilføj til playlist', en: 'Add to playlist' },
  'ctx.addToQueue':    { da: 'Tilføj til kø',    en: 'Add to queue' },
  'ctx.info':          { da: 'Detaljer',          en: 'Details' },

  // ── Language ──────────────────────────────────────────────────────────────
  'lang.label':        { da: 'Sprog',            en: 'Language' },
  'lang.da':           { da: 'Dansk',            en: 'Danish' },
  'lang.en':           { da: 'Engelsk',          en: 'English' },

  // ── Quota ─────────────────────────────────────────────────────────────────
  'quota.used':        { da: 'brugt',            en: 'used' },

  // ── Misc ──────────────────────────────────────────────────────────────────
  'misc.renameFailed':  { da: 'Omdøbning fejlede', en: 'Rename failed' },
  'misc.trashFailed':   { da: 'Flytning til papirkurv fejlede', en: 'Move to trash failed' },
  'misc.moveToTrash':   { da: 'Flytte til papirkurven?', en: 'Move to trash?' },
  'misc.folderName':    { da: 'Mappenavn:',      en: 'Folder name:' },
  'misc.moveHere':      { da: 'Flyt hertil',     en: 'Move here' },
  'misc.duplicateHere': { da: 'Dupliker her',    en: 'Duplicate here' },
  'misc.playlistCreated': { da: 'Playlist oprettet', en: 'Playlist created' },
  'misc.playlistName':  { da: 'Playlist navn:',  en: 'Playlist name:' },
  'misc.itemsMoved':    { da: 'element(er) flyttet', en: 'item(s) moved' },
  'misc.alreadyInBackup': { da: 'er allerede i auto backup', en: 'is already in auto backup' },
  'misc.addedToBackup': { da: 'tilføjet til auto backup', en: 'added to auto backup' },
  'misc.setupBackupFirst': { da: 'Opsæt backup først', en: 'Set up backup first' },
  'misc.addedToQueue':  { da: 'tilføjet til køen', en: 'added to queue' },
  'misc.alreadyInQueue':{ da: 'Nummeret er allerede i køen eller køen er fuld (max 50)', en: 'Track is already in the queue or queue is full (max 50)' },
  'misc.allInPlaylist': { da: 'Alle numre er allerede i playlisten eller den er fuld (max 50)', en: 'All tracks are already in the playlist or it is full (max 50)' },
  'misc.tracksAdded':   { da: 'nummer tilføjet til playlist', en: 'track(s) added to playlist' },
  'misc.playlistFolderInfo': { da: 'lydfiler — en playlist kan max indeholde 50 numre.', en: 'audio files — a playlist can contain max 50 tracks.' },

  // ── Shared / public link page ─────────────────────────────────────────────
  'shared.sharedWithYou':{ da: 'Delt med dig',   en: 'Shared with you' },
  'shared.sharedWithMe': { da: 'Delt med mig',   en: 'Shared with me' },
  'shared.invalidLink':  { da: 'Ugyldigt link.', en: 'Invalid link.' },
  'shared.expired':      { da: 'Dette delte link er ugyldigt eller udløbet.', en: 'This shared link is invalid or has expired.' },
  'shared.passwordProtected':{ da: 'Adgangskodebeskyttet', en: 'Password protected' },
  'shared.enterPassword':{ da: 'Indtast adgangskoden for at tilgå dette element.', en: 'Enter the password to access this shared item.' },
  'shared.incorrectPassword':{ da: 'Forkert adgangskode', en: 'Incorrect password' },
  'shared.accessFile':   { da: 'Åbn fil',        en: 'Access file' },
  'shared.folder':       { da: 'Mappe',          en: 'Folder' },
  'shared.expires':      { da: 'Udløber',        en: 'Expires' },
  'shared.emptyFolder':  { da: 'Denne mappe er tom', en: 'This folder is empty' },
  'shared.myShares':     { da: 'Mine delinger',    en: 'My shares' },
  'shared.noShares':     { da: 'Du deler ikke noget i øjeblikket', en: 'You are not sharing anything right now' },
  'shared.publicLink':   { da: 'Offentligt link',  en: 'Public link' },
  'shared.pendingInvite':{ da: 'Afventer invitation', en: 'Pending invite' },
  'shared.revokeShare':  { da: 'Fjern deling',     en: 'Revoke share' },
  'shared.revokeConfirm':{ da: 'Fjern denne deling?', en: 'Remove this share?' },
  'shared.sharesCount':  { da: '{n} deling(er)',   en: '{n} share(s)' },
  'shared.goToFolder':   { da: 'Åbn i Mine filer', en: 'Open in My files' },

  // ── Confirm dialogs (parameterized) ──────────────────────────────────────
  'confirm.trashNamed':{ da: 'Flytte "{name}" til papirkurven?', en: 'Move "{name}" to trash?' },
  'confirm.deleteForeverNamed': { da: 'Slet "{name}" permanent? Dette kan ikke fortrydes.', en: 'Permanently delete "{name}"? This cannot be undone.' },
  'confirm.deleteForeverCount': { da: 'Slet {count} fil(er) permanent? Dette kan ikke fortrydes.', en: 'Permanently delete {count} file(s)? This cannot be undone.' },

  // ── Trash bulk actions ────────────────────────────────────────────────────
  'trash.bulkRestored':    { da: '{count} fil(er) gendannet',         en: '{count} file(s) restored' },
  'trash.bulkDeleted':     { da: '{count} fil(er) slettet permanent',  en: '{count} file(s) permanently deleted' },
  'trash.restoreSelected': { da: 'Gendan {count} valgte',             en: 'Restore {count} selected' },
  'trash.deleteSelected':  { da: 'Slet {count} valgte permanent',     en: 'Delete {count} selected permanently' },

  // ── Text editor ───────────────────────────────────────────────────────────
  'editor.tooLarge':         { da: 'Filen er for stor til at åbne i editoren', en: 'File is too large to open in the editor' },
  'editor.tooLargeToEdit':   { da: 'For stor til redigering',         en: 'Too large to edit' },
  'editor.readOnly':         { da: 'Skrivebeskyttet',                  en: 'Read-only' },
  'editor.unsaved':          { da: 'Ikke gemt',                       en: 'Unsaved' },
  'editor.wordWrapOn':       { da: 'Slå tekstombrydning fra',         en: 'Disable word wrap' },
  'editor.wordWrapOff':      { da: 'Slå tekstombrydning til',         en: 'Enable word wrap' },
  'editor.revert':           { da: 'Fortryd',                         en: 'Revert' },
  'editor.revertTitle':      { da: 'Fortryd ændringer',               en: 'Revert changes' },
  'editor.closeWithUnsaved': { da: 'Du har ændringer der ikke er gemt. Vil du lukke alligevel?', en: 'You have unsaved changes. Close anyway?' },
  'editor.saved':            { da: 'Fil gemt',                        en: 'File saved' },
  'editor.conflict':         { da: 'Filen er ændret af en anden — genindlæs for at se ændringerne', en: 'File was changed by someone else — reload to see the changes' },
  'editor.saveFailed':       { da: 'Kunne ikke gemme filen',          en: 'Could not save file' },
  'editor.loadFailed':       { da: 'Kunne ikke indlæse filen',        en: 'Could not load file' },

  // ── Preview modal ─────────────────────────────────────────────────────────
  'preview.prevNav':          { da: 'Forrige (←)',                    en: 'Previous (←)' },
  'preview.nextNav':          { da: 'Næste (→)',                      en: 'Next (→)' },
  'preview.deleteFile':       { da: 'Slet fil?',                      en: 'Delete file?' },
  'preview.print':            { da: 'Print',                          en: 'Print' },
  'preview.downloadInstead':  { da: 'Download i stedet',              en: 'Download instead' },
  'preview.googleDriveFile':  { da: 'Dette er en Google Drive-fil og kan kun åbnes i Google Drive.', en: 'This is a Google Drive file and can only be opened in Google Drive.' },
  'preview.unsupported':      { da: 'Denne filtype kan ikke forhåndsvises.', en: 'This file type cannot be previewed.' },
  'preview.loadFailed':       { da: 'Kunne ikke indlæse filen.',      en: 'Failed to load file.' },
  'preview.loading':          { da: 'Indlæser…',                      en: 'Loading…' },
  'preview.imageLoadFailed':  { da: 'Billedet kunne ikke indlæses.',  en: 'Failed to load image.' },
  'preview.imageMayBeCorrupt':{ da: 'Filen er muligvis beskadiget.',  en: 'The file may be corrupted.' },
  'preview.deleteCorrupted':  { da: 'Slet beskadiget fil',            en: 'Delete corrupted file' },
  'preview.truncated':        { da: 'Forhåndsvisning afkortet til 1 MB. Download filen for at se det fulde indhold.', en: 'Preview truncated to 1 MB. Download the file to see the complete contents.' },

  // ── Banners ───────────────────────────────────────────────────────────────
  'banner.adminSession': { da: 'Admin support-session — viser som {user}. Alle handlinger registreres.', en: 'Admin support session — viewing as {user}. All actions are recorded.' },
  'banner.dismiss':      { da: 'Luk banner',                          en: 'Dismiss banner' },
  'offline.message':     { da: 'Du er offline — uploads genoptages automatisk når forbindelsen vender tilbage', en: 'You are offline — uploads will resume automatically when the connection returns' },

  // ── Upload zone ───────────────────────────────────────────────────────────
  'upload.dragging':        { da: 'Slip filer her for at uploade',    en: 'Drop files here to upload' },
  'upload.uploading':       { da: 'Uploader {count} fil(er)',         en: 'Uploading {count} file(s)' },
  'upload.failed':          { da: 'Upload fejlede',                   en: 'Upload failed' },
  'upload.paused':          { da: 'Offline — genoptages automatisk når forbindelsen vender tilbage', en: 'Offline — will resume automatically when the connection returns' },
  'upload.saving':          { da: 'Gemmer chunk… et øjeblik',         en: 'Saving chunk… one moment' },
  'upload.direct':          { da: 'Direkte',                          en: 'Direct' },
  'upload.directNote':      { da: 'Uploader direkte til serveren — bypasser Cloudflare for maksimal hastighed.', en: 'Uploading directly to the server — bypasses Cloudflare for maximum speed.' },
  'upload.cloudflareNote':  { da: 'Filer uploades via Cloudflare i 50 MB dele. Hastighed varierer — det er normalt at progressbaren "staller" kortvarigt mellem dele.', en: 'Files are uploaded via Cloudflare in 50 MB chunks. Speed may vary — it is normal for the progress bar to briefly stall between chunks.' },

  // ── Context menu (additional) ─────────────────────────────────────────────
} as const

type TranslationKey = keyof typeof translations

// ─── Context ─────────────────────────────────────────────────────────────────

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

const STORAGE_KEY = 'sharedrive_lang'

function getInitialLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'en' || stored === 'da') return stored
  } catch { /* SSR / privacy mode */ }
  // Default to browser language, fallback to Danish
  const nav = typeof navigator !== 'undefined' ? navigator.language : ''
  if (nav.startsWith('en')) return 'en'
  return 'da'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale)

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    try { localStorage.setItem(STORAGE_KEY, l) } catch { /* ignore */ }
  }, [])

  const t = useCallback((key: TranslationKey, vars?: Record<string, string | number>): string => {
    const entry = translations[key]
    if (!entry) return String(key)
    let text: string = entry[locale] ?? entry.da ?? String(key)
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(`{${k}}`, String(v))
      }
    }
    return text
  }, [locale])

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
