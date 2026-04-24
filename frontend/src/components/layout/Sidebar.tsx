import { Link, useRouterState } from '@tanstack/react-router'
import {
  Files,
  Share2,
  Clock,
  Trash2,
  Settings,
  Users,
  ScrollText,
  ShieldBan,
  HardDrive,
  Database,
  ScanSearch,
  History,
  Archive,
  ChevronDown,
  LogOut,
  ShieldCheck,
  Music,
  X,
  Plus,
} from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/lib/auth-context'
import { useI18n } from '@/lib/i18n'
import { api, createPlaylist } from '@/lib/api'
import { useQueryClient } from '@tanstack/react-query'
import { formatBytes, cn } from '@/lib/utils'
import { WebDAVDialog } from '@/components/layout/WebDAVDialog'
import { TOTPSetupDialog } from '@/components/layout/TOTPSetupDialog'
import { AddMusicDialog } from '@/components/files/AddMusicDialog'
import { Dial, RetroButton, LedDisplay, CassetteIcon } from '@/components/files/Dial'
import { usePlaylist } from '@/lib/playlist-context'

interface NavItem {
  to: string
  labelKey: string
  icon: React.ReactNode
  exact?: boolean
}

const mainNav: NavItem[] = [
  { to: '/files',    labelKey: 'nav.myFiles',   icon: <Files size={16} />,   exact: true },
  { to: '/shares',   labelKey: 'nav.shared',    icon: <Share2 size={16} /> },
  { to: '/recent',   labelKey: 'nav.recent',    icon: <Clock size={16} /> },
  { to: '/activity', labelKey: 'nav.activity',  icon: <History size={16} /> },
  { to: '/trash',    labelKey: 'nav.trash',     icon: <Trash2 size={16} /> },
  { to: '/backup',   labelKey: 'nav.backup',    icon: <Archive size={16} /> },
]

const guestNav: NavItem[] = [
  { to: '/shares',  labelKey: 'nav.shared',     icon: <Share2 size={16} /> },
]

const adminNav: NavItem[] = [
  { to: '/admin',              labelKey: 'nav.dashboard',  icon: <HardDrive size={16} />, exact: true },
  { to: '/admin/users',        labelKey: 'nav.users',       icon: <Users size={16} /> },
  { to: '/admin/audit-logs',   labelKey: 'nav.auditLog',    icon: <ScrollText size={16} /> },
  { to: '/admin/blocked-ips',  labelKey: 'nav.blockedIps',  icon: <ShieldBan size={16} /> },
  { to: '/admin/backup',       labelKey: 'nav.backup',      icon: <Database size={16} /> },
  { to: '/admin/storage',      labelKey: 'nav.storage',     icon: <ScanSearch size={16} /> },
  { to: '/admin/settings',     labelKey: 'nav.settings',    icon: <Settings size={16} /> },
]

function NavLink({ item }: { item: NavItem }) {
  const state = useRouterState()
  const { t } = useI18n()
  const active = item.exact
    ? state.location.pathname === item.to
    : state.location.pathname.startsWith(item.to)

  return (
    <Link
      to={item.to}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
        active
          ? 'bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-400 font-medium'
          : 'text-zinc-600 dark:text-slate-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148] hover:text-zinc-900 dark:hover:text-slate-100'
      }`}
    >
      <span className={active ? 'text-brand-600 dark:text-brand-400' : ''}>{item.icon}</span>
      {t(item.labelKey as any)}
    </Link>
  )
}

function fmt(s: number) {
  if (!isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export function Sidebar({ isOpen = false, onClose }: { isOpen?: boolean; onClose?: () => void }) {
  const { user, setUser } = useAuth()
  const qc = useQueryClient()
  const state = useRouterState()
  const { t, locale, setLocale } = useI18n()
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [showWebDAV, setShowWebDAV] = useState(false)
  const [showTOTP, setShowTOTP] = useState(false)
  const [playerExpanded, setPlayerExpanded] = useState(true)
  const [mobilePlayerOpen, setMobilePlayerOpen] = useState(false)
  const [showAddMusic, setShowAddMusic] = useState(false)

  const {
    activePlaylistId,
    activePlaylistName,
    tracks,
    isLoadingTracks,
    currentIndex,
    isPlaying,
    progress,
    duration,
    volume,
    bass,
    treble,
    clearPlaylist,
    jumpTo,
    togglePlay,
    next,
    prev,
    seek,
    setVolume,
    setBass,
    setTreble,
    toggleShuffle,
    shuffle,
    removeTrack,
    addTracks,
    setPlaylist,
    playlistMaxTracks,
  } = usePlaylist()

  // Handle adding music: when there's an active playlist just add tracks,
  // otherwise create a new playlist inline and set it as active.
  const handleAddMusic = async (fileIds: string[]) => {
    setShowAddMusic(false)
    if (fileIds.length === 0) return
    if (activePlaylistId) {
      await addTracks(fileIds)
    } else {
      try {
        const result = await createPlaylist(null, null, fileIds)
        const displayName = (result as any).name?.replace(/\.m3u$/i, '') ?? 'Playliste'
        setPlaylist((result as any).id, displayName)
      } catch { /* ignore */ }
    }
  }

  const handleLogout = async () => {
    try {
      await api.post('/api/v1/auth/logout', {})
    } finally {
      setUser(null)
      void qc.clear()
      window.location.href = '/login'
    }
  }

  const quota = user?.quota_bytes ?? 0
  const used = user?.quota_used_bytes ?? 0
  const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0
  const currentTrack = tracks[currentIndex]

  const handleSeekClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    seek((e.clientX - rect.left) / rect.width)
  }

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={onClose} />
      )}
      <aside className={[
        'flex flex-col w-60 shrink-0 bg-white dark:bg-[#1a1d27] border-r border-zinc-200 dark:border-[#2d3148] h-screen',
        'fixed inset-y-0 left-0 z-40 transition-transform duration-200',
        isOpen ? 'translate-x-0' : '-translate-x-full',
        'md:relative md:translate-x-0 md:z-auto',
      ].join(' ')}>

        {/* Logo */}
        <div className="px-4 h-14 flex items-center border-b border-zinc-200 dark:border-[#2d3148] shrink-0">
          <img src="/logo_name.png" alt="Sharedrive" className="h-7 w-auto" />
        </div>

        {/* Scrollable middle — nav, player, admin nav */}
        <div className="flex-1 overflow-y-auto min-h-0">

        {/* Main nav */}
        <nav className="px-2 py-3 space-y-0.5">
          {(user?.role === 'guest' ? guestNav : mainNav).map(item => (
            <NavLink key={item.to} item={item} />
          ))}
        </nav>

        {/* ── Music button when no active playlist ─────────────── */}
        {!activePlaylistId && user?.role !== 'guest' && (
          <div className="px-2 pb-2">
            <button
              onClick={() => setShowAddMusic(true)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-zinc-600 dark:text-slate-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148] hover:text-zinc-900 dark:hover:text-slate-100"
            >
              <Music size={16} />
              {t('player.addMusic' as any)}
            </button>
          </div>
        )}

        {/* ── Persistent sidebar player ─────────────────────────── */}
        {activePlaylistId && (
          <div className="mx-2 mb-2 rounded-xl border border-zinc-200 dark:border-[#2d3148] overflow-hidden bg-white dark:bg-[#1a1d27]">

            {/* Mini controls bar — always visible */}
            <div className="px-2 pt-2 pb-1.5">
              {/* Row 1: LED display — full width */}
              <div className="flex items-center gap-1 mb-1.5">
                <LedDisplay
                  text={tracks.length === 0 && !isLoadingTracks
                    ? (activePlaylistName ?? '---')
                    : (currentTrack?.name ?? activePlaylistName ?? '---')}
                  trackNum={currentTrack ? currentIndex : null}
                  onClick={() => setPlayerExpanded(v => !v)}
                  expanded={playerExpanded}
                />
                <button
                  onClick={clearPlaylist}
                  className="p-0.5 text-zinc-300 hover:text-red-500 dark:hover:text-red-400 transition-colors shrink-0"
                  title={t('player.closePlayer')}
                >
                  <X size={12} />
                </button>
              </div>

              {/* Row 2: transport controls */}
              <div className="flex items-center justify-center gap-2 mb-1.5">
                <RetroButton
                  onClick={prev}
                  disabled={currentIndex === 0}
                  icon={<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="0" y="1" width="2" height="8"/><polygon points="8,1 2,5 8,9"/></svg>}
                  label={t('player.previous')}
                  size={24}
                />
                <RetroButton
                  onClick={togglePlay}
                  disabled={!currentTrack}
                  active={isPlaying}
                  color="#4ade80"
                  icon={isPlaying
                    ? <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="3" height="8"/><rect x="6" y="1" width="3" height="8"/></svg>
                    : <svg width="11" height="11" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg>}
                  label={isPlaying ? t('player.pause') : t('player.play')}
                  size={32}
                />
                <RetroButton
                  onClick={next}
                  disabled={!shuffle && currentIndex >= tracks.length - 1}
                  icon={<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="8" y="1" width="2" height="8"/><polygon points="2,1 8,5 2,9"/></svg>}
                  label={t('player.next')}
                  size={24}
                />
                <RetroButton
                  onClick={toggleShuffle}
                  active={shuffle}
                  color="#a78bfa"
                  icon={<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/></svg>}
                  label={shuffle ? t('player.shuffleOn') : t('player.shuffleOff')}
                  size={24}
                />
              </div>

              {/* Row 3: progress bar */}
              <div
                className="w-full h-1 bg-zinc-200 dark:bg-[#2d3148] rounded-full cursor-pointer"
                onClick={handleSeekClick}
              >
                <div
                  className="h-full bg-brand-500 rounded-full"
                  style={{ width: duration ? `${(progress / duration) * 100}%` : '0%' }}
                />
              </div>
              <div className="flex justify-between mt-0.5">
                <span className="text-[9px] text-zinc-400 tabular-nums">{fmt(progress)}</span>
                <span className="text-[9px] text-zinc-400 tabular-nums">{fmt(duration)}</span>
              </div>
            </div>

            {/* Expanded panel: track list + volume */}
            {playerExpanded && (
              <div className="border-t border-zinc-100 dark:border-[#2d3148]">
                {/* Track list */}
                <div className="overflow-y-auto max-h-[180px] divide-y divide-zinc-50 dark:divide-[#2d3148]">
                  {tracks.length === 0 && !isLoadingTracks ? (
                    /* Empty state — invite user to add audio files */
                    <button
                      onClick={() => setShowAddMusic(true)}
                      className="w-full flex flex-col items-center justify-center gap-1.5 py-5 text-center hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors group"
                    >
                      <Plus size={18} className="text-zinc-300 dark:text-slate-600 group-hover:text-brand-500 transition-colors" />
                      <span className="text-[11px] text-zinc-400 dark:text-slate-500 group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">
                        {t('player.addMusic' as any)}
                      </span>
                    </button>
                  ) : (
                    tracks.map((track, i) => (
                      <div
                        key={track.id}
                        className={cn(
                          'flex items-center gap-1.5 px-2 py-1.5 group',
                          i === currentIndex && 'bg-brand-50 dark:bg-brand-900/20',
                        )}
                      >
                        <button
                          onClick={() => jumpTo(i)}
                          className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                        >
                          <span className="text-[10px] text-zinc-400 tabular-nums w-4 shrink-0 text-right">
                            {i + 1}
                          </span>
                          <span className={cn(
                            'text-[11px] truncate',
                            i === currentIndex
                              ? 'font-semibold text-brand-600 dark:text-brand-400'
                              : 'text-zinc-700 dark:text-slate-300',
                          )}>
                            {track.name}
                          </span>
                        </button>
                        <button
                          onClick={() => { void removeTrack(track.id) }}
                          className="shrink-0 p-0.5 text-zinc-200 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                          title={t('player.removeTrack')}
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ))
                  )}
                </div>

                {/* Add music button (when tracks exist, show as small footer link) */}
                {tracks.length > 0 && tracks.length < playlistMaxTracks && (
                  <div className="border-t border-zinc-50 dark:border-[#2d3148]">
                    <button
                      onClick={() => setShowAddMusic(true)}
                      className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
                    >
                      <Plus size={10} />
                      {t('player.addMusic' as any)}
                    </button>
                  </div>
                )}

                {/* Bass / Volume / Treble dials */}
                <div className="flex items-end justify-center gap-5 px-2.5 py-3 border-t border-zinc-100 dark:border-[#2d3148]" style={{ background: '#181b28' }}>
                  <Dial value={bass}   onChange={setBass}   label="Bass"   color="#22d3ee" size={60} />
                  <Dial value={volume} onChange={setVolume} label="Volume" color="#4ade80" size={60} />
                  <Dial value={treble} onChange={setTreble} label="Treble" color="#f87171" size={60} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Admin nav */}
        {user?.is_admin && (
          <>
            <div className="mx-4 border-t border-zinc-200 dark:border-[#2d3148] my-1" />
            <div className="px-4 py-1">
              <p className="text-[11px] uppercase tracking-widest text-zinc-400 dark:text-slate-500 font-medium">
                Admin
              </p>
            </div>
            <nav className="px-2 pb-3 space-y-0.5">
              {adminNav.map(item => (
                <NavLink key={item.to} item={item} />
              ))}
            </nav>
          </>
        )}

        {/* WebDAV — only visible in the Files section */}
        {user?.role !== 'guest' && state.location.pathname.startsWith('/files') && (
          <>
            <div className="mx-4 border-t border-zinc-200 dark:border-[#2d3148] my-1" />
            <nav className="px-2 pb-3 space-y-0.5">
              <button
                onClick={() => setShowWebDAV(true)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-zinc-600 dark:text-slate-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148] hover:text-zinc-900 dark:hover:text-slate-100"
              >
                <HardDrive size={16} />
                WebDAV
              </button>
            </nav>
          </>
        )}

        </div>{/* /scrollable middle */}

        {/* Quota */}
        {quota > 0 && (
          <div className="px-4 py-3 border-t border-zinc-100 dark:border-[#2d3148]">
            <div className="flex justify-between text-xs text-muted mb-1">
              <span>{formatBytes(used)} used</span>
              <span>{formatBytes(quota)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-[#2d3148] overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${pct > 90 ? 'bg-red-500' : pct > 75 ? 'bg-amber-500' : 'bg-brand-500'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {/* User profile */}
        <div className="border-t border-zinc-200 dark:border-[#2d3148] p-2 relative">
          <button
            onClick={() => setShowUserMenu(v => !v)}
            className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors"
          >
            <div className="w-7 h-7 rounded-full bg-brand-600 dark:bg-brand-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
              {user?.display_name?.charAt(0).toUpperCase() ?? '?'}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-sm font-medium text-zinc-900 dark:text-slate-100 truncate">
                {user?.display_name}
              </p>
              <p className="text-xs text-muted truncate">{user?.email}</p>
            </div>
            <ChevronDown size={14} className="text-zinc-400 shrink-0" />
          </button>

          {showUserMenu && (
            <div className="absolute bottom-full left-2 right-2 mb-1 bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl shadow-lg py-1 z-50">
              <button
                onClick={() => { setShowUserMenu(false); setShowTOTP(true) }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
              >
                <ShieldCheck size={14} className={user?.totp_enabled ? 'text-green-500' : 'text-zinc-400'} />
                {user?.totp_enabled ? t('auth.2faEnabled') : t('auth.enable2fa')}
              </button>
              <button
                onClick={() => { setLocale(locale === 'da' ? 'en' : 'da'); setShowUserMenu(false) }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
              >
                <span className="text-sm">{locale === 'da' ? '🇬🇧' : '🇩🇰'}</span>
                {locale === 'da' ? 'English' : 'Dansk'}
              </button>
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
              >
                <LogOut size={14} />
                {t('action.signOut')}
              </button>
            </div>
          )}
        </div>

        {showWebDAV && <WebDAVDialog onClose={() => setShowWebDAV(false)} />}
        {showTOTP && (
          <TOTPSetupDialog
            isEnabled={!!user?.totp_enabled}
            onClose={() => setShowTOTP(false)}
            onChanged={() => { void qc.invalidateQueries({ queryKey: ['me'] }) }}
          />
        )}
        {showAddMusic && (
          <AddMusicDialog
            onClose={() => setShowAddMusic(false)}
            onAdd={fileIds => { void handleAddMusic(fileIds) }}
          />
        )}
      </aside>

      {/* ── Mobile bottom player bar ─────────────────────────── */}
      {activePlaylistId && (
        <>
          {/* Expanded sheet backdrop */}
          {mobilePlayerOpen && (
            <div
              className="md:hidden fixed inset-0 z-[55] bg-black/60"
              onClick={() => setMobilePlayerOpen(false)}
            />
          )}

          {/* Expanded full player sheet */}
          {mobilePlayerOpen && (
            <div
              className="md:hidden fixed bottom-0 left-0 right-0 z-[60] bg-white dark:bg-[#1a1d27] rounded-t-2xl border-t border-zinc-200 dark:border-[#2d3148] shadow-2xl flex flex-col"
              style={{ maxHeight: '85dvh' }}
            >
              {/* Sheet header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-[#2d3148] shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Music size={14} className="text-brand-500 shrink-0" />
                  <span className="font-semibold text-sm text-zinc-900 dark:text-slate-100 truncate">{activePlaylistName ?? 'Playlist'}</span>
                </div>
                <button
                  onClick={() => setMobilePlayerOpen(false)}
                  className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-slate-200 shrink-0"
                >
                  <ChevronDown size={22} />
                </button>
              </div>

              {/* Controls */}
              <div className="px-4 py-3 shrink-0">
                <p className="text-sm font-semibold text-zinc-900 dark:text-slate-100 truncate mb-3">
                  {currentTrack?.name ?? '—'}
                </p>
                <div
                  className="w-full h-1.5 bg-zinc-200 dark:bg-[#2d3148] rounded-full cursor-pointer mb-1"
                  onClick={handleSeekClick}
                >
                  <div
                    className="h-full bg-brand-500 rounded-full"
                    style={{ width: duration ? `${(progress / duration) * 100}%` : '0%' }}
                  />
                </div>
                <div className="flex justify-between mb-4">
                  <span className="text-[10px] text-zinc-400 tabular-nums">{fmt(progress)}</span>
                  <span className="text-[10px] text-zinc-400 tabular-nums">{fmt(duration)}</span>
                </div>
                <div className="flex items-center justify-center gap-4 mb-4">
                  <RetroButton
                    onClick={toggleShuffle}
                    active={shuffle}
                    color="#a78bfa"
                    icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/></svg>}
                    label={shuffle ? t('player.shuffleOn') : t('player.shuffleOff')}
                    size={36}
                  />
                  <RetroButton
                    onClick={prev}
                    disabled={currentIndex === 0}
                    icon={<svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor"><rect x="0" y="1" width="2" height="8"/><polygon points="8,1 2,5 8,9"/></svg>}
                    label={t('player.previous')}
                    size={42}
                  />
                  <RetroButton
                    onClick={togglePlay}
                    disabled={!currentTrack}
                    active={isPlaying}
                    color="#4ade80"
                    icon={isPlaying
                      ? <svg width="16" height="16" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="3" height="8"/><rect x="6" y="1" width="3" height="8"/></svg>
                      : <svg width="16" height="16" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg>}
                    label={isPlaying ? t('player.pause') : t('player.play')}
                    size={52}
                  />
                  <RetroButton
                    onClick={next}
                    disabled={!shuffle && currentIndex >= tracks.length - 1}
                    icon={<svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor"><rect x="8" y="1" width="2" height="8"/><polygon points="2,1 8,5 2,9"/></svg>}
                    label={t('player.next')}
                    size={42}
                  />
                </div>
                <div className="flex items-end justify-center gap-6 py-4" style={{ background: '#181b28' }}>
                  <Dial value={bass}   onChange={setBass}   label="Bass"   color="#22d3ee" size={76} />
                  <Dial value={volume} onChange={setVolume} label="Volume" color="#4ade80" size={76} />
                  <Dial value={treble} onChange={setTreble} label="Treble" color="#f87171" size={76} />
                </div>
              </div>

              {/* Track list */}
              <div className="flex-1 overflow-y-auto border-t border-zinc-100 dark:border-[#2d3148] divide-y divide-zinc-50 dark:divide-[#2d3148]">
                {tracks.map((track, i) => (
                  <div
                    key={track.id}
                    className={cn(
                      'flex items-center gap-2 px-4 py-3 group',
                      i === currentIndex && 'bg-brand-50 dark:bg-brand-900/20',
                    )}
                  >
                    <button
                      onClick={() => { jumpTo(i); setMobilePlayerOpen(false) }}
                      className="flex-1 min-w-0 flex items-center gap-3 text-left"
                    >
                      <span className="text-xs text-zinc-400 tabular-nums w-5 shrink-0 text-right">{i + 1}</span>
                      <span className={cn(
                        'text-sm truncate',
                        i === currentIndex
                          ? 'font-semibold text-brand-600 dark:text-brand-400'
                          : 'text-zinc-700 dark:text-slate-300',
                      )}>
                        {track.name}
                      </span>
                    </button>
                    <button
                      onClick={() => { void removeTrack(track.id) }}
                      className="p-1.5 text-zinc-300 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Mini bottom bar */}
          <div
            className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-white/95 dark:bg-[#1a1d27]/95 backdrop-blur-sm border-t border-zinc-200 dark:border-[#2d3148] shadow-lg"
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
          >
            {/* Progress strip */}
            <div
              className="h-0.5 bg-zinc-200 dark:bg-[#2d3148] cursor-pointer"
              onClick={handleSeekClick}
            >
              <div
                className="h-full bg-brand-500"
                style={{ width: duration ? `${(progress / duration) * 100}%` : '0%' }}
              />
            </div>
            <div className="flex items-center gap-1.5 px-3 py-2">
              {/* Track info — tap to expand */}
              <button
                onClick={() => setMobilePlayerOpen(v => !v)}
                className="flex-1 min-w-0 flex items-center gap-2.5 text-left"
              >
                <div className="w-9 h-9 rounded-lg bg-zinc-800/80 flex items-center justify-center shrink-0">
                  <CassetteIcon size={20} className="text-brand-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-zinc-900 dark:text-slate-100 truncate">
                    {currentTrack?.name ?? (tracks.length === 0 && !isLoadingTracks ? t('player.empty' as any) : activePlaylistName)}
                  </p>
                  <p className="text-[10px] text-zinc-400 truncate">{activePlaylistName}</p>
                </div>
              </button>
              <RetroButton
                onClick={prev}
                disabled={currentIndex === 0}
                icon={<svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor"><rect x="0" y="1" width="2" height="8"/><polygon points="8,1 2,5 8,9"/></svg>}
                label={t('player.previous')}
                size={32}
              />
              <RetroButton
                onClick={togglePlay}
                disabled={!currentTrack}
                active={isPlaying}
                color="#4ade80"
                icon={isPlaying
                  ? <svg width="13" height="13" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="3" height="8"/><rect x="6" y="1" width="3" height="8"/></svg>
                  : <svg width="13" height="13" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg>}
                label={isPlaying ? t('player.pause') : t('player.play')}
                size={38}
              />
              <RetroButton
                onClick={next}
                disabled={!shuffle && currentIndex >= tracks.length - 1}
                icon={<svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor"><rect x="8" y="1" width="2" height="8"/><polygon points="2,1 8,5 2,9"/></svg>}
                label={t('player.next')}
                size={32}
              />
              <button
                onClick={clearPlaylist}
                className="p-2 text-zinc-300 hover:text-red-500 dark:hover:text-red-400 transition-colors shrink-0"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
