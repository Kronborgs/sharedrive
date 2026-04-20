import type { FileItem } from '@/types/api'
import { formatBytes, formatRelative, cn } from '@/lib/utils'
import { MoreVertical, Folder, UserPlus } from 'lucide-react'
import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { FileThumbnail } from './FileThumbnail'

interface FileListProps {
  items: FileItem[]
  selectedIds: Set<string>
  onSelect: (id: string, additive: boolean) => void
  onOpen: (item: FileItem) => void
  onContextMenu: (item: FileItem, x: number, y: number) => void
  onSelectAll?: () => void
  onQuickShare?: (item: FileItem) => void
}

export function FileList({ items, selectedIds, onSelect, onOpen, onContextMenu, onSelectAll, onQuickShare }: FileListProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
        <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-[#2d3148] flex items-center justify-center">
          <Folder size={28} className="text-zinc-400" />
        </div>
        <p className="text-sm text-muted">This folder is empty</p>
        <p className="text-xs text-zinc-400">Drag files here or click Upload to add files</p>
      </div>
    )
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-zinc-100 dark:border-[#2d3148]">
          <th className="w-10 px-3 py-2.5">
            {onSelectAll ? (
              <input
                type="checkbox"
                className="rounded border-zinc-300 dark:border-zinc-600 cursor-pointer"
                checked={items.length > 0 && selectedIds.size === items.length}
                ref={el => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < items.length }}
                onChange={onSelectAll}
                onClick={e => e.stopPropagation()}
              />
            ) : null}
          </th>
          <th className="text-left px-3 py-2.5 text-xs font-medium text-muted uppercase">Name</th>
          <th className="text-right px-3 py-2.5 text-xs font-medium text-muted uppercase w-24 hidden md:table-cell">Size</th>
          <th className="text-right px-3 py-2.5 text-xs font-medium text-muted uppercase w-32 hidden md:table-cell">Modified</th>
          <th className="w-16" />
        </tr>
      </thead>
      <tbody>
        {items.map(item => (
          <FileRow
            key={item.id}
            item={item}
            selected={selectedIds.has(item.id)}
            onSelect={onSelect}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
            onQuickShare={onQuickShare}
          />
        ))}
      </tbody>
    </table>
  )
}

function FileRow({
  item,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
  onQuickShare,
}: {
  item: FileItem
  selected: boolean
  onSelect: (id: string, additive: boolean) => void
  onOpen: (item: FileItem) => void
  onContextMenu: (item: FileItem, x: number, y: number) => void
  onQuickShare?: (item: FileItem) => void
}) {
  const moreRef = useRef<HTMLButtonElement>(null)

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    onContextMenu(item, e.clientX, e.clientY)
  }

  return (
    <tr
      className={cn(
        'group border-b border-zinc-50 dark:border-[#2d3148]/50 cursor-pointer transition-colors',
        selected
          ? 'bg-brand-50 dark:bg-brand-900/20'
          : 'hover:bg-zinc-50 dark:hover:bg-[#2d3148]/50',
      )}
      onClick={e => {
        if ((e.target as HTMLElement).closest('button,input')) return
        if (item.is_folder) onOpen(item)
        else onSelect(item.id, e.metaKey || e.ctrlKey)
      }}
      onDoubleClick={() => { if (!item.is_folder) onOpen(item) }}
      onContextMenu={handleContextMenu}
    >
      {/* Checkbox cell */}
      <td className="w-10 px-3 py-2.5" onClick={e => { e.stopPropagation(); onSelect(item.id, true) }}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onSelect(item.id, true)}
          onClick={e => e.stopPropagation()}
          className={cn(
            'rounded border-zinc-300 dark:border-zinc-600 cursor-pointer transition-opacity',
            selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        />
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <FileThumbnail item={item} size={20} />
          <span className="truncate text-zinc-900 dark:text-slate-100 text-sm" title={item.name}>
            {item.name}
          </span>
          {item.tags?.map(tag => (
            <span
              key={tag.id}
              className="shrink-0 hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium text-white"
              style={{ backgroundColor: tag.color }}
            >
              {tag.name}
            </span>
          ))}
          {item.shared && (
            <span className="shrink-0 hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
              Shared
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 text-right text-xs text-muted hidden md:table-cell tabular-nums">
        {item.is_folder ? <FolderSize id={item.id} /> : formatBytes(item.size_bytes)}
      </td>
      <td className="px-3 py-2.5 text-right text-xs text-muted hidden md:table-cell whitespace-nowrap">
        {formatRelative(item.updated_at)}
      </td>
      <td className="pr-2">
        <div className="flex items-center justify-end gap-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity">
          {onQuickShare && (
            <button
              onClick={e => { e.stopPropagation(); onQuickShare(item) }}
              className="p-1 rounded text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors"
              title="Share…"
            >
              <UserPlus size={14} />
            </button>
          )}
          <button
            ref={moreRef}
            onClick={e => { e.stopPropagation(); onContextMenu(item, moreRef.current!.getBoundingClientRect().left, moreRef.current!.getBoundingClientRect().bottom) }}
            className="p-1 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300 hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors"
            title="More options"
          >
            <MoreVertical size={14} />
          </button>
        </div>
      </td>
    </tr>
  )
}

// --- Grid view ---
interface FileGridProps {
  items: FileItem[]
  selectedIds: Set<string>
  onSelect: (id: string, additive: boolean) => void
  onOpen: (item: FileItem) => void
  onContextMenu: (item: FileItem, x: number, y: number) => void
}

export function FileGrid({ items, selectedIds, onSelect, onOpen, onContextMenu }: FileGridProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
        <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-[#2d3148] flex items-center justify-center">
          <Folder size={28} className="text-zinc-400" />
        </div>
        <p className="text-sm text-muted">This folder is empty</p>
        <p className="text-xs text-zinc-400">Drag files here or click Upload to add files</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 p-1">
      {items.map(item => (
        <div
          key={item.id}
          className={cn(
            'group flex flex-col items-center gap-1.5 p-3 rounded-xl cursor-pointer select-none transition-colors',
            selectedIds.has(item.id)
              ? 'bg-brand-50 dark:bg-brand-900/20 ring-2 ring-brand-400'
              : 'hover:bg-zinc-100 dark:hover:bg-[#2d3148]',
          )}
          onClick={e => {
            if (item.is_folder) onOpen(item)
            else onSelect(item.id, e.metaKey || e.ctrlKey)
          }}
          onDoubleClick={() => { if (!item.is_folder) onOpen(item) }}
          onContextMenu={e => { e.preventDefault(); onContextMenu(item, e.clientX, e.clientY) }}
        >
          <FileThumbnail item={item} size={48} />
          <span className="text-xs text-zinc-900 dark:text-slate-100 text-center break-all line-clamp-2 w-full" title={item.name}>
            {item.name}
          </span>
          {!item.is_folder && (
            <span className="text-[10px] text-muted">{formatBytes(item.size_bytes)}</span>
          )}
          {item.is_folder && (
            <span className="text-[10px] text-muted"><FolderSize id={item.id} /></span>
          )}
        </div>
      ))}
    </div>
  )
}

// ── FolderSize ────────────────────────────────────────────────────────────────
// Lazily fetches recursive folder size via GET /api/v1/files/{id}/size.
// Shows "…" while loading, then the formatted size + file count.
function FolderSize({ id }: { id: string }) {
  const { data } = useQuery({
    queryKey: ['folder-size', id],
    queryFn: ({ signal }) =>
      api.get<{ size_bytes: number; file_count: number }>(`/api/v1/files/${id}/size`, signal),
    staleTime: 60_000,   // re-fetch after 1 min
    gcTime: 120_000,
  })

  if (!data) return <span className="text-zinc-400">…</span>
  if (data.size_bytes === 0) return <span className="text-zinc-400">Empty</span>
  return <>{formatBytes(data.size_bytes)}</>
}
