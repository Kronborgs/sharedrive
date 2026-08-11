import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { FileItem } from '@/types/api'
import { Folder, ChevronRight, Home, X, Loader2 } from 'lucide-react'

interface BreadcrumbEntry {
  id: string | null  // null = root
  name: string
}

interface FolderPickerDialogProps {
  readonly title: string
  readonly confirmLabel: string
  /** ID of the item being moved/copied — excluded from the folder list */
  readonly excludeId?: string
  readonly onConfirm: (folderId: string | null) => void
  readonly onClose: () => void
}

export function FolderPickerDialog({
  title,
  confirmLabel,
  excludeId,
  onConfirm,
  onClose,
}: FolderPickerDialogProps) {
  // breadcrumbs trail: [{id: null, name: 'My Files'}, {id: 'uuid', name: 'Docs'}, …]
  const [trail, setTrail] = useState<BreadcrumbEntry[]>([{ id: null, name: 'My Files' }])
  const currentFolderId = trail[trail.length - 1].id
  const filesEndpoint = currentFolderId === null ? '/api/v1/files' : '/api/v1/files?parent_id=' + currentFolderId

  const { data: items, isLoading } = useQuery({
    queryKey: ['folder-picker', currentFolderId],
    queryFn: ({ signal }) => api.get<FileItem[]>(filesEndpoint, signal),
  })

  const folders = (items ?? []).filter(
    f => f.is_folder && f.id !== excludeId,
  )

  function navigateInto(folder: FileItem) {
    setTrail(prev => [...prev, { id: folder.id, name: folder.name }])
  }

  function navigateTo(index: number) {
    setTrail(prev => prev.slice(0, index + 1))
  }

  let folderListContent: React.ReactNode
  if (isLoading) {
    folderListContent = (
      <div className="flex items-center justify-center h-20 text-muted">
        <Loader2 size={16} className="animate-spin" />
      </div>
    )
  } else if (folders.length === 0) {
    folderListContent = <p className="text-xs text-muted text-center py-6">No folders here</p>
  } else {
    folderListContent = (
      <>
        {folders.map(folder => (
          <button type="button"
            key={folder.id}
            onClick={() => navigateInto(folder)}
            className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors text-left"
          >
            <Folder size={15} className="text-brand-500 shrink-0" />
            <span className="truncate">{folder.name}</span>
            <ChevronRight size={13} className="ml-auto text-zinc-300 dark:text-slate-600 shrink-0" />
          </button>
        ))}
      </>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div
        className="relative z-10 bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl w-80 max-h-[480px] flex flex-col shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-[#2d3148]">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">{title}</h3>
          <button type="button"
            onClick={onClose}
            className="p-1 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300 transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-zinc-100 dark:border-[#2d3148] text-xs text-muted flex-wrap">
          {trail.map((entry, i) => (
            <span key={trail.slice(0, i + 1).map(p => p.id ?? 'root').join('/')} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={11} className="text-zinc-300 dark:text-slate-600 shrink-0" />}
              {i === trail.length - 1 ? (
                <span className="font-medium text-zinc-700 dark:text-slate-200 flex items-center gap-1">
                  {i === 0 && <Home size={11} />}
                  {entry.name}
                </span>
              ) : (
                <button type="button"
                  onClick={() => navigateTo(i)}
                  className="hover:text-zinc-700 dark:hover:text-slate-200 transition-colors flex items-center gap-1"
                >
                  {i === 0 && <Home size={11} />}
                  {entry.name}
                </button>
              )}
            </span>
          ))}
        </div>

        {/* Folder list */}
        <div className="flex-1 overflow-y-auto py-1 min-h-[120px]">
          {folderListContent}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-100 dark:border-[#2d3148]">
          <button type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-muted hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
          >
            Cancel
          </button>
          <button type="button"
            onClick={() => onConfirm(currentFolderId)}
            className="px-4 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
