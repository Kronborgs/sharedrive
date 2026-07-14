import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FolderOpen, X, Upload, Folder, ChevronRight, Home, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { FileItem } from '@/types/api'

interface BreadcrumbEntry {
  id: string | null
  name: string
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

interface ShareTargetDialogProps {
  files: File[]
  /** The folder the user is currently browsing (pre-selected as default target) */
  currentFolderId: string | null
  onUpload: (files: File[], targetFolderId: string | null) => void
  onClose: () => void
}

export function ShareTargetDialog({
  files,
  currentFolderId,
  onUpload,
  onClose,
}: Readonly<ShareTargetDialogProps>) {
  const [trail, setTrail] = useState<BreadcrumbEntry[]>([
    { id: null, name: 'My Files' },
  ])
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)

  // The target folder — defaults to whatever the user had open
  const [targetFolderId, setTargetFolderId] = useState<string | null>(currentFolderId)
  const [targetFolderName, setTargetFolderName] = useState<string>(
    currentFolderId ? '...' : 'My Files',
  )

  // Resolve the name of the current folder if we have an id
  const { data: folderCrumbs } = useQuery({
    queryKey: ['share-target-folder-name', currentFolderId],
    queryFn: ({ signal }) =>
      currentFolderId
        ? api.get<FileItem[]>(`/api/v1/files/breadcrumbs?folder_id=${currentFolderId}`, signal)
        : Promise.resolve<FileItem[]>([]),
    enabled: !!currentFolderId,
  })
  useEffect(() => {
    if (folderCrumbs && folderCrumbs.length > 0)
      setTargetFolderName(folderCrumbs[folderCrumbs.length - 1].name)
  }, [folderCrumbs])

  // Folder listing for the picker
  const pickerFolderId = trail[trail.length - 1].id
  const pickerQuery = pickerFolderId ? `parent_id=${pickerFolderId}` : ''
  const { data: pickerItems, isLoading: pickerLoading } = useQuery({
    queryKey: ['share-target-picker', pickerFolderId],
    queryFn: ({ signal }) =>
      api.get<FileItem[]>(`/api/v1/files?${pickerQuery}`, signal),
    enabled: folderPickerOpen,
  })
  const folders = (pickerItems ?? []).filter(f => f.is_folder)
  let folderBrowserEmptyState: React.ReactNode = null
  if (pickerLoading) {
    folderBrowserEmptyState = (
      <div className="flex items-center justify-center py-4">
        <Loader2 size={14} className="animate-spin text-zinc-400" />
      </div>
    )
  } else if (folders.length === 0) {
    folderBrowserEmptyState = (
      <p className="text-[11px] text-zinc-400 dark:text-slate-500 text-center py-3">Ingen under-mapper</p>
    )
  }

  function selectFolder(id: string | null, name: string) {
    setTargetFolderId(id)
    setTargetFolderName(name)
    setFolderPickerOpen(false)
    setTrail([{ id: null, name: 'My Files' }])
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div
        className="relative z-10 bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-t-2xl sm:rounded-xl w-full sm:w-96 max-h-[90vh] flex flex-col shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-zinc-100 dark:border-[#2d3148]">
          <div className="flex items-center gap-2">
            <Upload size={16} className="text-brand-500 shrink-0" />
            <span className="text-sm font-semibold text-zinc-900 dark:text-slate-100">
              Upload {files.length} {files.length === 1 ? 'fil' : 'filer'}
            </span>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-200 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Incoming files list */}
        <ul className="px-4 py-2 max-h-36 overflow-y-auto border-b border-zinc-100 dark:border-[#2d3148] divide-y divide-zinc-50 dark:divide-[#2d3148]/60">
          {files.map(f => (
            <li key={f.name} className="flex items-center gap-2 py-1.5">
              <span className="flex-1 text-xs text-zinc-800 dark:text-slate-200 truncate">{f.name}</span>
              <span className="text-[10px] text-zinc-400 dark:text-slate-500 shrink-0">{formatBytes(f.size)}</span>
            </li>
          ))}
        </ul>

        {/* Destination folder selector */}
        <div className="px-4 py-3 border-b border-zinc-100 dark:border-[#2d3148] space-y-1.5">
          <p className="text-xs font-medium text-zinc-500 dark:text-slate-400 uppercase tracking-wide">
            Upload til mappe
          </p>
          <button
            onClick={() => setFolderPickerOpen(v => !v)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors text-left"
          >
            <FolderOpen size={15} className="text-amber-500 shrink-0" />
            <span className="flex-1 text-sm text-zinc-800 dark:text-slate-200 truncate">{targetFolderName}</span>
            <ChevronRight size={14} className={`text-zinc-400 shrink-0 transition-transform ${folderPickerOpen ? 'rotate-90' : ''}`} />
          </button>

          {/* Inline folder browser */}
          {folderPickerOpen && (
            <div className="rounded-lg border border-zinc-200 dark:border-[#2d3148] overflow-hidden">
              {/* Breadcrumb nav */}
              <div className="flex items-center gap-0.5 px-2 py-1.5 bg-zinc-50 dark:bg-[#0f1117] border-b border-zinc-100 dark:border-[#2d3148] overflow-x-auto">
                {trail.map((entry, idx) => (
                  <span key={entry.id ?? entry.name} className="flex items-center gap-0.5 shrink-0">
                    {idx > 0 && <ChevronRight size={11} className="text-zinc-300 dark:text-slate-600" />}
                    <button
                      onClick={() => setTrail(prev => prev.slice(0, idx + 1))}
                      className="flex items-center gap-1 text-[11px] text-zinc-600 dark:text-slate-400 hover:text-zinc-900 dark:hover:text-slate-100 transition-colors"
                    >
                      {idx === 0 && <Home size={11} />}
                      {entry.name}
                    </button>
                  </span>
                ))}
              </div>

              {/* "Upload here" row — always at top */}
              <button
                onClick={() => selectFolder(pickerFolderId, trail[trail.length - 1].name)}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-brand-600 dark:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/10 transition-colors border-b border-zinc-100 dark:border-[#2d3148]"
              >
                <Upload size={12} />
                Upload her
              </button>

              {/* Sub-folders */}
              <div className="max-h-36 overflow-y-auto">
                {folderBrowserEmptyState ?? folders.map(f => (
                  <button
                    key={f.id}
                    onClick={() => setTrail(prev => [...prev, { id: f.id, name: f.name }])}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors border-b border-zinc-50 dark:border-[#2d3148]/40 last:border-0"
                  >
                    <Folder size={13} className="text-amber-500 shrink-0" />
                    <span className="flex-1 truncate text-left">{f.name}</span>
                    <ChevronRight size={12} className="text-zinc-300 dark:text-slate-600 shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 px-4 py-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-zinc-600 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
          >
            Annullér
          </button>
          <button
            onClick={() => { onUpload(files, targetFolderId); onClose() }}
            className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors"
          >
            <Upload size={14} />
            Upload
          </button>
        </div>
      </div>
    </div>
  )
}
