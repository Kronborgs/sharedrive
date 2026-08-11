import { useEffect, useRef } from 'react'
import type { FileItem } from '@/types/api'
import {
  Download,
  Share2,
  Pencil,
  Trash2,
  FolderOpen,
  RotateCcw,
  Scissors,
  Copy,
  Info,
  Archive,
  ListMusic,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

export type ContextAction =
  | 'open'
  | 'download'
  | 'share'
  | 'rename'
  | 'move'
  | 'copy'
  | 'backup'
  | 'playlist'
  | 'addtoqueue'
  | 'playInPlayer'
  | 'addToPlayer'
  | 'trash'
  | 'restore'
  | 'delete'
  | 'info'

interface FileContextMenuProps {
  item: FileItem
  x: number
  y: number
  isTrash?: boolean
  allowedActions?: ContextAction[]
  canAddToQueue?: boolean
  canAddToPlayer?: boolean
  onAction: (action: ContextAction, item: FileItem) => void
  onClose: () => void
}

interface MenuItem {
  action: ContextAction
  label: string
  icon: React.ReactNode
  danger?: boolean
  divider?: boolean
  /** Only render this item when the context target is a folder */
  folderOnly?: boolean
  /** Only render this item when the context target is a non-folder audio file */
  audioOnly?: boolean
  /** Only render this item when the context target is a .m3u playlist file */
  m3uOnly?: boolean
  /** Only render this item when m3uOnly=true AND there is an active player playlist */
  requiresActivePlayer?: boolean
}

export function FileContextMenu({ item, x, y, isTrash = false, allowedActions, canAddToQueue = false, canAddToPlayer = false, onAction, onClose }: Readonly<FileContextMenuProps>) {
  const ref = useRef<HTMLDivElement>(null)
  const { t } = useI18n()

  const normalItems: MenuItem[] = [
    { action: 'open',       label: t('ctx.open'),          icon: <FolderOpen size={14} /> },
    { action: 'download',   label: t('ctx.download'),      icon: <Download size={14} />, divider: true },
    { action: 'share',      label: t('ctx.share'),         icon: <Share2 size={14} /> },
    { action: 'rename',     label: t('ctx.rename'),        icon: <Pencil size={14} /> },
    { action: 'move',       label: t('ctx.move'),          icon: <Scissors size={14} /> },
    { action: 'copy',       label: t('ctx.copy'),          icon: <Copy size={14} />, divider: true },
    { action: 'backup',       label: t('ctx.backup'),          icon: <Archive size={14} /> },
    { action: 'playlist',     label: t('ctx.addToPlaylist'),   icon: <ListMusic size={14} />, folderOnly: true },
    { action: 'addtoqueue',   label: t('ctx.addToQueue'),      icon: <ListMusic size={14} />, audioOnly: true },
    { action: 'playInPlayer', label: t('ctx.playInPlayer'),    icon: <ListMusic size={14} />, m3uOnly: true },
    { action: 'addToPlayer',  label: t('ctx.addToPlayer'),     icon: <ListMusic size={14} />, m3uOnly: true, requiresActivePlayer: true },
    { action: 'info',         label: t('ctx.info'),            icon: <Info size={14} />, divider: true },
    { action: 'trash',      label: t('ctx.trash'),         icon: <Trash2 size={14} />, danger: true },
  ]

  const trashItems: MenuItem[] = [
    { action: 'restore', label: t('ctx.restore'), icon: <RotateCcw size={14} /> },
    { action: 'delete',  label: t('ctx.delete'),  icon: <Trash2 size={14} />, danger: true },
  ]

  // Close on outside click / escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('mousedown', handleClick)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [onClose])

  // Adjust position so menu stays within viewport
  const menuWidth = 200
  const menuHeight = 280
  const adjustedX = x + menuWidth > window.innerWidth ? x - menuWidth : x
  const adjustedY = y + menuHeight > window.innerHeight ? y - menuHeight : y

  const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.aac', '.m4a', '.opus', '.ogg', '.m4b']
  const isAudio = !item.is_folder && AUDIO_EXTS.some(e => item.name.toLowerCase().endsWith(e))
  const isM3u = !item.is_folder && item.name.toLowerCase().endsWith('.m3u')

  const allItems = isTrash ? trashItems : normalItems
  let items = allowedActions ? allItems.filter(mi => allowedActions.includes(mi.action)) : allItems
  // Hide folder-only actions for non-folder items
  items = items.filter(mi => !mi.folderOnly || item.is_folder)
  // Hide audio-only actions for non-audio items, or when no queue is active
  items = items.filter(mi => !mi.audioOnly || (isAudio && canAddToQueue))
  // Hide m3u-only actions for non-m3u items; hide requiresActivePlayer when no active player
  items = items.filter(mi => !mi.m3uOnly || isM3u)
  items = items.filter(mi => !mi.requiresActivePlayer || canAddToPlayer)

  return (
    <div
      ref={ref}
      style={{ top: adjustedY, left: adjustedX }}
      className="fixed z-50 w-48 bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl shadow-xl py-1 text-sm"
    >
      <div className="px-3 py-1.5 text-xs text-muted font-medium truncate border-b border-zinc-100 dark:border-[#2d3148] mb-1">
        {item.name}
      </div>
      {items.map(mi => (
        <div key={mi.action}>
          {mi.divider && <div className="my-1 border-t border-zinc-100 dark:border-[#2d3148]" />}
          <button type="button"
            onClick={() => { onAction(mi.action, item); onClose() }}
            className={cn(
              'w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors',
              mi.danger ? 'text-red-600 dark:text-red-400' : 'text-zinc-700 dark:text-slate-300',
            )}
          >
            {mi.icon}
            {mi.label}
          </button>
        </div>
      ))}
    </div>
  )
}
