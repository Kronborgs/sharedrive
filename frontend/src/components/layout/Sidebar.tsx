import { Link, useRouterState } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
	StickyNote,
} from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/lib/auth-context'
import { useI18n } from '@/lib/i18n'
import { api, createPlaylist } from '@/lib/api'
import { formatBytes, cn } from '@/lib/utils'
import { WebDAVDialog } from '@/components/layout/WebDAVDialog'
import { TOTPSetupDialog } from '@/components/layout/TOTPSetupDialog'
import { AddMusicDialog } from '@/components/files/AddMusicDialog'
import { Dial, RetroButton, LedDisplay, CassetteIcon } from '@/components/files/Dial'
import { usePlaylist } from '@/lib/playlist-context'
import { APP_VERSION } from '@/version'
import { CHANGELOG_ENTRIES } from '@/changelog.generated'
import { ignorePromise } from '@/lib/ignore-promise'

interface NavItem {
  to: string
  labelKey: string
  icon: React.ReactNode
  exact?: boolean
}

const mainNav: NavItem[] = [
  { to: '/files',    labelKey: 'nav.myFiles',   icon: <Files size={16} />,   exact: true },
	{ to: '/notes',    labelKey: 'nav.notes',     icon: <StickyNote size={16} /> },
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

function NavLink({ item }: Readonly<{ item: NavItem }>) {
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
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function formatBuildDate(raw?: string) {
  if (!raw) return 'unknown'
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  return new Intl.DateTimeFormat('da-DK', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

type SidebarPlaylist = ReturnType<typeof usePlaylist>
type SidebarTrack = SidebarPlaylist['tracks'][number] | undefined

type SidebarBuildInfo = {
  version: string
  build_date: string
}

function getQuotaBarClass(pct: number) {
  if (pct > 90) return 'bg-red-500'
  if (pct > 75) return 'bg-amber-500'
  return 'bg-brand-500'
}

function renderPlayerIcon(isPlaying: boolean, size: number) {
  if (isPlaying) {
    return <svg width={size} height={size} viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="3" height="8"/><rect x="6" y="1" width="3" height="8"/></svg>
  }

  return <svg width={size} height={size} viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg>
}

function getSidebarPlayerText(activePlaylistName: string | null, tracks: SidebarPlaylist['tracks'], currentTrack: SidebarTrack, isLoadingTracks: boolean) {
  if (tracks.length === 0 && !isLoadingTracks) {
    return activePlaylistName ?? '---'
  }

  return currentTrack?.name ?? activePlaylistName ?? '---'
}

function getMobilePlayerText(currentTrack: SidebarTrack, tracks: SidebarPlaylist['tracks'], isLoadingTracks: boolean, activePlaylistName: string | null, t: ReturnType<typeof useI18n>['t']) {
  if (currentTrack?.name) return currentTrack.name
  if (tracks.length === 0 && !isLoadingTracks) return t('player.empty' as any)
  return activePlaylistName ?? '---'
}

function SidebarProgressBar({
  progress,
  duration,
  onSeek,
  className,
  fillClassName,
}: Readonly<{
  progress: number
  duration: number
  onSeek: (e: React.MouseEvent<HTMLElement>) => void
  className: string
  fillClassName: string
}>) {
  return (
    <button
      type="button"
      aria-label="Seek playback"
      className={className}
      onClick={onSeek}
    >
      <span
        className={fillClassName}
        style={{ width: duration ? `${(progress / duration) * 100}%` : '0%' }}
      />
    </button>
  )
}

function SidebarDesktopPlayer({
  playlist,
  currentTrack,
  playerExpanded,
  onToggleExpanded,
  onShowAddMusic,
  onSeek,
  t,
}: Readonly<{
  playlist: SidebarPlaylist
  currentTrack: SidebarTrack
  playerExpanded: boolean
  onToggleExpanded: () => void
  onShowAddMusic: () => void
  onSeek: (e: React.MouseEvent<HTMLElement>) => void
  t: ReturnType<typeof useI18n>['t']
}>) {
  if (!playlist.activePlaylistId) return null

  const trackText = getSidebarPlayerText(playlist.activePlaylistName, playlist.tracks, currentTrack, playlist.isLoadingTracks)
  const canAddMoreTracks = playlist.tracks.length > 0 && playlist.tracks.length < playlist.playlistMaxTracks

  return (
    <div className="mx-2 mb-2 rounded-xl border border-zinc-200 dark:border-[#2d3148] overflow-hidden bg-white dark:bg-[#1a1d27]">
      <div className="px-2 pt-2 pb-1.5">
        <div className="flex items-center gap-1 mb-1.5">
          <LedDisplay
            text={trackText}
            trackNum={currentTrack ? playlist.currentIndex : null}
            onClick={onToggleExpanded}
            expanded={playerExpanded}
          />
          <button
            onClick={playlist.clearPlaylist}
            className="p-0.5 text-zinc-300 hover:text-red-500 dark:hover:text-red-400 transition-colors shrink-0"
            title={t('player.closePlayer')}
          >
            <X size={12} />
          </button>
        </div>

        <div className="flex items-center justify-center gap-2 mb-1.5">
          <RetroButton
            onClick={playlist.prev}
            disabled={playlist.currentIndex === 0}
            icon={<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="0" y="1" width="2" height="8"/><polygon points="8,1 2,5 8,9"/></svg>}
            label={t('player.previous')}
            size={24}
          />
          <RetroButton
            onClick={playlist.togglePlay}
            disabled={!currentTrack}
            active={playlist.isPlaying}
            color="#4ade80"
            icon={renderPlayerIcon(playlist.isPlaying, 11)}
            label={playlist.isPlaying ? t('player.pause') : t('player.play')}
            size={32}
          />
          <RetroButton
            onClick={playlist.next}
            disabled={!playlist.shuffle && playlist.currentIndex >= playlist.tracks.length - 1}
            icon={<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="8" y="1" width="2" height="8"/><polygon points="2,1 8,5 2,9"/></svg>}
            label={t('player.next')}
            size={24}
          />
          <RetroButton
            onClick={playlist.toggleShuffle}
            active={playlist.shuffle}
            color="#a78bfa"
            icon={<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/></svg>}
            label={playlist.shuffle ? t('player.shuffleOn') : t('player.shuffleOff')}
            size={24}
          />
        </div>

        <SidebarProgressBar
          progress={playlist.progress}
          duration={playlist.duration}
          onSeek={onSeek}
          className="w-full h-1 bg-zinc-200 dark:bg-[#2d3148] rounded-full cursor-pointer"
          fillClassName="block h-full bg-brand-500 rounded-full"
        />
        <div className="flex justify-between mt-0.5">
          <span className="text-[9px] text-zinc-400 tabular-nums">{fmt(playlist.progress)}</span>
          <span className="text-[9px] text-zinc-400 tabular-nums">{fmt(playlist.duration)}</span>
        </div>
      </div>

      {playerExpanded && (
        <div className="border-t border-zinc-100 dark:border-[#2d3148]">
          <div className="overflow-y-auto max-h-[180px] divide-y divide-zinc-50 dark:divide-[#2d3148]">
            {playlist.tracks.length === 0 && !playlist.isLoadingTracks ? (
              <button
                onClick={onShowAddMusic}
                className="w-full flex flex-col items-center justify-center gap-1.5 py-5 text-center hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors group"
              >
                <Plus size={18} className="text-zinc-300 dark:text-slate-600 group-hover:text-brand-500 transition-colors" />
                <span className="text-[11px] text-zinc-400 dark:text-slate-500 group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">
                  {t('player.addMusic' as any)}
                </span>
              </button>
            ) : (
              playlist.tracks.map((track, index) => {
                const isCurrent = index === playlist.currentIndex

                return (
                  <div
                    key={track.id}
                    className={cn(
                      'flex items-center gap-1.5 px-2 py-1.5 group',
                      isCurrent && 'bg-brand-50 dark:bg-brand-900/20',
                    )}
                  >
                    <button
                      onClick={() => playlist.jumpTo(index)}
                      className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                    >
                      <span className="text-[10px] text-zinc-400 tabular-nums w-4 shrink-0 text-right">
                        {index + 1}
                      </span>
                      <span className={cn(
                        'text-[11px] truncate',
                        isCurrent
                          ? 'font-semibold text-brand-600 dark:text-brand-400'
                          : 'text-zinc-700 dark:text-slate-300',
                      )}>
                        {track.name}
                      </span>
                    </button>
                    <button
                      onClick={() => { ignorePromise(playlist.removeTrack(track.id)) }}
                      className="shrink-0 p-0.5 text-zinc-200 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                      title={t('player.removeTrack')}
                    >
                      <X size={11} />
                    </button>
                  </div>
                )
              })
            )}
          </div>

          {canAddMoreTracks && (
            <div className="border-t border-zinc-50 dark:border-[#2d3148]">
              <button
                onClick={onShowAddMusic}
                className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
              >
                <Plus size={10} />
                {t('player.addMusic' as any)}
              </button>
            </div>
          )}

          <div className="flex items-end justify-center gap-5 px-2.5 py-3 border-t border-zinc-100 dark:border-[#2d3148]" style={{ background: '#181b28' }}>
            <Dial value={playlist.bass} onChange={playlist.setBass} label="Bass" color="#22d3ee" size={60} min={-12} max={12} step={0.5} />
            <Dial value={playlist.volume} onChange={playlist.setVolume} label="Volume" color="#4ade80" size={60} min={0} max={1} step={0.01} />
            <Dial value={playlist.treble} onChange={playlist.setTreble} label="Treble" color="#f87171" size={60} min={-12} max={12} step={0.5} />
          </div>
        </div>
      )}
    </div>
  )
}

function SidebarBuildInfoModal({
  isOpen,
  versionInfo,
  onClose,
  t,
}: Readonly<{
  isOpen: boolean
  versionInfo?: SidebarBuildInfo
  onClose: () => void
  t: ReturnType<typeof useI18n>['t']
}>) {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3">
      <button
        type="button"
        aria-label={t('action.close')}
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-2xl bg-white dark:bg-[#151826] border border-zinc-200 dark:border-[#2d3148] shadow-xl">
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-[#2d3148] flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">{t('buildInfo.title')}</h3>
            <p className="text-xs text-zinc-500 dark:text-slate-400 mt-0.5">
              {t('buildInfo.versionBuilt', {
                version: versionInfo?.version ?? APP_VERSION,
                date: formatBuildDate(versionInfo?.build_date),
              })}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-slate-200"
            aria-label={t('action.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto divide-y divide-zinc-100 dark:divide-[#2d3148]">
          {CHANGELOG_ENTRIES.length === 0 && (
            <p className="px-4 py-3 text-sm text-zinc-500 dark:text-slate-400">{t('buildInfo.empty')}</p>
          )}
          {CHANGELOG_ENTRIES.map(entry => (
            <div key={`${entry.hash}-${entry.date}-${entry.message}`} className="px-4 py-3 space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded-md bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400 font-mono">
                  {entry.hash}
                </span>
                <span className="text-zinc-500 dark:text-slate-400">{entry.date}</span>
              </div>
              <p className="text-sm text-zinc-900 dark:text-slate-100">{entry.message}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function SidebarUserPanel({
  user,
  showUserMenu,
  locale,
  onToggleMenu,
  onOpenTOTP,
  onToggleLocale,
  onOpenBuildInfo,
  onLogout,
  t,
}: Readonly<{
  user: ReturnType<typeof useAuth>['user']
  showUserMenu: boolean
  locale: ReturnType<typeof useI18n>['locale']
  onToggleMenu: () => void
  onOpenTOTP: () => void
  onToggleLocale: () => void
  onOpenBuildInfo: () => void
  onLogout: () => void
  t: ReturnType<typeof useI18n>['t']
}>) {
  return (
    <div className="border-t border-zinc-200 dark:border-[#2d3148] p-2 relative">
      <button
        onClick={onToggleMenu}
        className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors"
      >
        <div className="w-7 h-7 rounded-full bg-brand-600 dark:bg-brand-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
          {user?.display_name?.charAt(0).toUpperCase() ?? '?'}
        </div>
        <div className="flex-1 min-w-0 text-left">
          <p className="text-sm font-medium text-zinc-900 dark:text-slate-100 truncate">{user?.display_name}</p>
          <p className="text-xs text-muted truncate">{user?.email}</p>
        </div>
        <ChevronDown size={14} className="text-zinc-400 shrink-0" />
      </button>

      {showUserMenu && (
        <div className="absolute bottom-full left-2 right-2 mb-1 bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl shadow-lg py-1 z-50">
          <button
            onClick={onOpenTOTP}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
          >
            <ShieldCheck size={14} className={user?.totp_enabled ? 'text-green-500' : 'text-zinc-400'} />
            {user?.totp_enabled ? t('auth.2faEnabled') : t('auth.enable2fa')}
          </button>
          <button
            onClick={onToggleLocale}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
          >
            <span className="text-sm">{locale === 'da' ? '🇬🇧' : '🇩🇰'}</span>
            {locale === 'da' ? 'English' : 'Dansk'}
          </button>
          <button
            onClick={onOpenBuildInfo}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
          >
            <ScrollText size={14} className="text-zinc-400" />
            {t('buildInfo.title')}
          </button>
          <button
            onClick={onLogout}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
          >
            <LogOut size={14} />
            {t('action.signOut')}
          </button>
          <div className="px-3 py-2 border-t border-zinc-100 dark:border-[#2d3148]">
            <p className="text-xs text-zinc-400 dark:text-zinc-600">v{APP_VERSION}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function SidebarMobilePlayer({
  playlist,
  currentTrack,
  mobilePlayerOpen,
  onSetOpen,
  onSeek,
  t,
}: Readonly<{
  playlist: SidebarPlaylist
  currentTrack: SidebarTrack
  mobilePlayerOpen: boolean
  onSetOpen: (open: boolean) => void
  onSeek: (e: React.MouseEvent<HTMLElement>) => void
  t: ReturnType<typeof useI18n>['t']
}>) {
  if (!playlist.activePlaylistId) return null

  return (
    <>
      {mobilePlayerOpen && (
        <button
          type="button"
          aria-label={t('action.close')}
          className="md:hidden fixed inset-0 z-[55] bg-black/60"
          onClick={() => onSetOpen(false)}
        />
      )}

      {mobilePlayerOpen && (
        <div
          className="md:hidden fixed bottom-0 left-0 right-0 z-[60] bg-white dark:bg-[#1a1d27] rounded-t-2xl border-t border-zinc-200 dark:border-[#2d3148] shadow-2xl flex flex-col"
          style={{ maxHeight: '85dvh' }}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-[#2d3148] shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <Music size={14} className="text-brand-500 shrink-0" />
              <span className="font-semibold text-sm text-zinc-900 dark:text-slate-100 truncate">{playlist.activePlaylistName ?? 'Playlist'}</span>
            </div>
            <button
              onClick={() => onSetOpen(false)}
              className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-slate-200 shrink-0"
            >
              <ChevronDown size={22} />
            </button>
          </div>

          <div className="px-4 py-3 shrink-0">
            <p className="text-sm font-semibold text-zinc-900 dark:text-slate-100 truncate mb-3">{currentTrack?.name ?? '—'}</p>
            <SidebarProgressBar
              progress={playlist.progress}
              duration={playlist.duration}
              onSeek={onSeek}
              className="w-full h-1.5 bg-zinc-200 dark:bg-[#2d3148] rounded-full cursor-pointer mb-1"
              fillClassName="block h-full bg-brand-500 rounded-full"
            />
            <div className="flex justify-between mb-4">
              <span className="text-[10px] text-zinc-400 tabular-nums">{fmt(playlist.progress)}</span>
              <span className="text-[10px] text-zinc-400 tabular-nums">{fmt(playlist.duration)}</span>
            </div>
            <div className="flex items-center justify-center gap-4 mb-4">
              <RetroButton
                onClick={playlist.toggleShuffle}
                active={playlist.shuffle}
                color="#a78bfa"
                icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/></svg>}
                label={playlist.shuffle ? t('player.shuffleOn') : t('player.shuffleOff')}
                size={36}
              />
              <RetroButton onClick={playlist.prev} disabled={playlist.currentIndex === 0} icon={<svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor"><rect x="0" y="1" width="2" height="8"/><polygon points="8,1 2,5 8,9"/></svg>} label={t('player.previous')} size={42} />
              <RetroButton
                onClick={playlist.togglePlay}
                disabled={!currentTrack}
                active={playlist.isPlaying}
                color="#4ade80"
                icon={renderPlayerIcon(playlist.isPlaying, 16)}
                label={playlist.isPlaying ? t('player.pause') : t('player.play')}
                size={52}
              />
              <RetroButton onClick={playlist.next} disabled={!playlist.shuffle && playlist.currentIndex >= playlist.tracks.length - 1} icon={<svg width="14" height="14" viewBox="0 0 10 10" fill="currentColor"><rect x="8" y="1" width="2" height="8"/><polygon points="2,1 8,5 2,9"/></svg>} label={t('player.next')} size={42} />
            </div>
            <div className="flex items-end justify-center gap-6 py-4" style={{ background: '#181b28' }}>
              <Dial value={playlist.bass} onChange={playlist.setBass} label="Bass" color="#22d3ee" size={76} min={-12} max={12} step={0.5} />
              <Dial value={playlist.volume} onChange={playlist.setVolume} label="Volume" color="#4ade80" size={76} min={0} max={1} step={0.01} />
              <Dial value={playlist.treble} onChange={playlist.setTreble} label="Treble" color="#f87171" size={76} min={-12} max={12} step={0.5} />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto border-t border-zinc-100 dark:border-[#2d3148] divide-y divide-zinc-50 dark:divide-[#2d3148]">
            {playlist.tracks.map((track, index) => {
              const isCurrent = index === playlist.currentIndex

              return (
                <div
                  key={track.id}
                  className={cn(
                    'flex items-center gap-2 px-4 py-3 group',
                    isCurrent && 'bg-brand-50 dark:bg-brand-900/20',
                  )}
                >
                  <button
                    onClick={() => { playlist.jumpTo(index); onSetOpen(false) }}
                    className="flex-1 min-w-0 flex items-center gap-3 text-left"
                  >
                    <span className="text-xs text-zinc-400 tabular-nums w-5 shrink-0 text-right">{index + 1}</span>
                    <span className={cn(
                      'text-sm truncate',
                      isCurrent
                        ? 'font-semibold text-brand-600 dark:text-brand-400'
                        : 'text-zinc-700 dark:text-slate-300',
                    )}>
                      {track.name}
                    </span>
                  </button>
                  <button
                    onClick={() => { ignorePromise(playlist.removeTrack(track.id)) }}
                    className="p-1.5 text-zinc-300 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-white/95 dark:bg-[#1a1d27]/95 backdrop-blur-sm border-t border-zinc-200 dark:border-[#2d3148] shadow-lg"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <SidebarProgressBar
          progress={playlist.progress}
          duration={playlist.duration}
          onSeek={onSeek}
          className="h-0.5 bg-zinc-200 dark:bg-[#2d3148] cursor-pointer"
          fillClassName="block h-full bg-brand-500"
        />
        <div className="flex items-center gap-1.5 px-3 py-2">
          <button
            onClick={() => onSetOpen(!mobilePlayerOpen)}
            className="flex-1 min-w-0 flex items-center gap-2.5 text-left"
          >
            <div className="w-9 h-9 rounded-lg bg-zinc-800/80 flex items-center justify-center shrink-0">
              <CassetteIcon size={20} className="text-brand-400" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-zinc-900 dark:text-slate-100 truncate">
                {getMobilePlayerText(currentTrack, playlist.tracks, playlist.isLoadingTracks, playlist.activePlaylistName, t)}
              </p>
              <p className="text-[10px] text-zinc-400 truncate">{playlist.activePlaylistName}</p>
            </div>
          </button>
          <RetroButton onClick={playlist.prev} disabled={playlist.currentIndex === 0} icon={<svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor"><rect x="0" y="1" width="2" height="8"/><polygon points="8,1 2,5 8,9"/></svg>} label={t('player.previous')} size={32} />
          <RetroButton
            onClick={playlist.togglePlay}
            disabled={!currentTrack}
            active={playlist.isPlaying}
            color="#4ade80"
            icon={renderPlayerIcon(playlist.isPlaying, 13)}
            label={playlist.isPlaying ? t('player.pause') : t('player.play')}
            size={38}
          />
          <RetroButton onClick={playlist.next} disabled={!playlist.shuffle && playlist.currentIndex >= playlist.tracks.length - 1} icon={<svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor"><rect x="8" y="1" width="2" height="8"/><polygon points="2,1 8,5 2,9"/></svg>} label={t('player.next')} size={32} />
          <button
            onClick={playlist.clearPlaylist}
            className="p-2 text-zinc-300 hover:text-red-500 dark:hover:text-red-400 transition-colors shrink-0"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </>
  )
}

export function Sidebar({ isOpen = false, onClose }: Readonly<{ isOpen?: boolean; onClose?: () => void }>) {
  const { user, setUser } = useAuth()
  const qc = useQueryClient()
  const state = useRouterState()
  const { t, locale, setLocale } = useI18n()
  const playlist = usePlaylist()
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [showWebDAV, setShowWebDAV] = useState(false)
  const [showTOTP, setShowTOTP] = useState(false)
  const [showBuildInfo, setShowBuildInfo] = useState(false)
  const [playerExpanded, setPlayerExpanded] = useState(true)
  const [mobilePlayerOpen, setMobilePlayerOpen] = useState(false)
  const [showAddMusic, setShowAddMusic] = useState(false)

  const { data: versionInfo } = useQuery({
    queryKey: ['system', 'version'],
    queryFn: ({ signal }) => api.get<SidebarBuildInfo>('/api/v1/system/version', signal),
    staleTime: 60_000,
  })

  const currentTrack = playlist.tracks[playlist.currentIndex]
  const isGuest = user?.role === 'guest'
  const quota = user?.quota_bytes ?? 0
  const used = user?.quota_used_bytes ?? 0
  const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0

  const handleAddMusic = async (fileIds: string[]) => {
    setShowAddMusic(false)
    if (fileIds.length === 0) return

    if (playlist.activePlaylistId) {
      await playlist.addTracks(fileIds)
      return
    }

    try {
      const result = await createPlaylist(null, null, fileIds)
      const displayName = (result as any).name?.replace(/\.m3u$/i, '') ?? 'Playliste'
      playlist.setPlaylist((result as any).id, displayName)
    } catch {
      // ignore
    }
  }

  const handleLogout = async () => {
    try {
      await api.post('/api/v1/auth/logout', {})
    } finally {
      setUser(null)
      qc.clear()
      window.location.href = '/login'
    }
  }

  const handleSeekClick = (e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    playlist.seek((e.clientX - rect.left) / rect.width)
  }

  return (
    <>
      {isOpen && (
        <button
          type="button"
          aria-label={t('action.close')}
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={onClose}
        />
      )}

      <aside className={[
        'flex flex-col w-60 shrink-0 bg-white dark:bg-[#1a1d27] border-r border-zinc-200 dark:border-[#2d3148] h-screen',
        'fixed inset-y-0 left-0 z-40 transition-transform duration-200',
        isOpen ? 'translate-x-0' : '-translate-x-full',
        'md:relative md:translate-x-0 md:z-auto',
      ].join(' ')}>
        <div className="px-4 h-14 flex items-center border-b border-zinc-200 dark:border-[#2d3148] shrink-0">
          <img src="/logo_name.png" alt="Sharedrive" className="h-7 w-auto" />
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          <nav className="px-2 py-3 space-y-0.5">
            {(isGuest ? guestNav : mainNav).map(item => (
              <NavLink key={item.to} item={item} />
            ))}
          </nav>

          {!playlist.activePlaylistId && !isGuest && (
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

          <SidebarDesktopPlayer
            playlist={playlist}
            currentTrack={currentTrack}
            playerExpanded={playerExpanded}
            onToggleExpanded={() => setPlayerExpanded(value => !value)}
            onShowAddMusic={() => setShowAddMusic(true)}
            onSeek={handleSeekClick}
            t={t}
          />

          {user?.is_admin && (
            <>
              <div className="mx-4 border-t border-zinc-200 dark:border-[#2d3148] my-1" />
              <div className="px-4 py-1">
                <p className="text-[11px] uppercase tracking-widest text-zinc-400 dark:text-slate-500 font-medium">Admin</p>
              </div>
              <nav className="px-2 pb-3 space-y-0.5">
                {adminNav.map(item => (
                  <NavLink key={item.to} item={item} />
                ))}
              </nav>
            </>
          )}

          {!isGuest && state.location.pathname.startsWith('/files') && (
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
        </div>

        {quota > 0 && (
          <div className="px-4 py-3 border-t border-zinc-100 dark:border-[#2d3148]">
            <div className="flex justify-between text-xs text-muted mb-1">
              <span>{formatBytes(used)} used</span>
              <span>{formatBytes(quota)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-[#2d3148] overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${getQuotaBarClass(pct)}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        <SidebarUserPanel
          user={user}
          showUserMenu={showUserMenu}
          locale={locale}
          onToggleMenu={() => setShowUserMenu(value => !value)}
          onOpenTOTP={() => {
            setShowUserMenu(false)
            setShowTOTP(true)
          }}
          onToggleLocale={() => {
            setLocale(locale === 'da' ? 'en' : 'da')
            setShowUserMenu(false)
          }}
          onOpenBuildInfo={() => {
            setShowUserMenu(false)
            setShowBuildInfo(true)
          }}
          onLogout={handleLogout}
          t={t}
        />

        {showWebDAV && <WebDAVDialog onClose={() => setShowWebDAV(false)} />}
        {showTOTP && (
          <TOTPSetupDialog
            isEnabled={!!user?.totp_enabled}
            onClose={() => setShowTOTP(false)}
            onChanged={() => { ignorePromise(qc.invalidateQueries({ queryKey: ['me'] })) }}
          />
        )}
        {showAddMusic && (
          <AddMusicDialog
            onClose={() => setShowAddMusic(false)}
            onAdd={fileIds => { ignorePromise(handleAddMusic(fileIds)) }}
          />
        )}
        <SidebarBuildInfoModal
          isOpen={showBuildInfo}
          versionInfo={versionInfo}
          onClose={() => setShowBuildInfo(false)}
          t={t}
        />
      </aside>

      <SidebarMobilePlayer
        playlist={playlist}
        currentTrack={currentTrack}
        mobilePlayerOpen={mobilePlayerOpen}
        onSetOpen={setMobilePlayerOpen}
        onSeek={handleSeekClick}
        t={t}
      />
    </>
  )
}

