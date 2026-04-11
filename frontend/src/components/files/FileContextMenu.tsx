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
} from 'lucide-react'
import { cn } from '@/lib/utils'

export type ContextAction =
  | 'open'
  | 'download'
  | 'share'
  | 'rename'
  | 'move'
  | 'copy'
  | 'backup'
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
  onAction: (action: ContextAction, item: FileItem) => void
  onClose: () => void
}

interface MenuItem {
  action: ContextAction
  label: string
  icon: React.ReactNode
  danger?: boolean
  divider?: boolean
}

const normalItems: MenuItem[] = [
  { action: 'open',     label: 'Open',      icon: <FolderOpen size={14} /> },
  { action: 'download', label: 'Download',  icon: <Download size={14} />, divider: true },
  { action: 'share',    label: 'Share…',    icon: <Share2 size={14} /> },
  { action: 'rename',   label: 'Rename',    icon: <Pencil size={14} /> },
  { action: 'move',     label: 'Move',      icon: <Scissors size={14} /> },
  { action: 'copy',     label: 'Duplicate', icon: <Copy size={14} />, divider: true },
  { action: 'backup',   label: 'Add to backup', icon: <Archive size={14} /> },
  { action: 'info',     label: 'Details',   icon: <Info size={14} />, divider: true },
  { action: 'trash',    label: 'Move to Trash', icon: <Trash2 size={14} />, danger: true },
]

const trashItems: MenuItem[] = [
  { action: 'restore', label: 'Restore',  icon: <RotateCcw size={14} /> },
  { action: 'delete',  label: 'Delete permanently', icon: <Trash2 size={14} />, danger: true },
]

export function FileContextMenu({ item, x, y, isTrash = false, allowedActions, onAction, onClose }: FileContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

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

  const allItems = isTrash ? trashItems : normalItems
  const items = allowedActions ? allItems.filter(mi => allowedActions.includes(mi.action)) : allItems

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
          <button
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
