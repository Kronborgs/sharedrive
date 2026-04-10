import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useCallback, useEffect } from 'react'
import { useAuth } from '@/lib/auth-context'
import { z } from 'zod'
import { api, createPlaylist } from '@/lib/api'
import type { FileItem } from '@/types/api'
import { FileList, FileGrid } from '@/components/files/FileViews'
import { FileContextMenu, type ContextAction } from '@/components/files/FileContextMenu'
import { DropZone, UploadProgress, useUploader } from '@/components/files/UploadZone'
import { ShareDialog } from '@/components/files/ShareDialog'
import { PreviewModal } from '@/components/files/PreviewModal'
import { DownloadDialog } from '@/components/files/DownloadDialog'
import { LayoutList, LayoutGrid, Upload, FolderPlus, ChevronRight, Home, Share2, Pencil, Trash2, Download, X, ListMusic } from 'lucide-react'
import { toast } from 'sonner'

const searchSchema = z.object({
  folder: z.string().optional(),
})

export const Route = createFileRoute('/_auth/files/')({
  validateSearch: searchSchema,
  component: FilesPage,
})

type ViewMode = 'list' | 'grid'

interface ContextMenuState {
  item: FileItem
  x: number
  y: number
}

function FilesPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { folder: folderId = null } = Route.useSearch()
  const qc = useQueryClient()

  const [view, setView] = useState<ViewMode>('list')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [shareItem, setShareItem] = useState<FileItem | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [previewItem, setPreviewItem] = useState<FileItem | null>(null)
  const [downloadIds, setDownloadIds] = useState<string[] | null>(null)

  const { uploads, startUpload, dismiss, directUpload } = useUploader(folderId)

  const { data: breadcrumbs } = useQuery({
    queryKey: ['breadcrumbs', folderId],
    queryFn: ({ signal }) =>
      folderId
        ? api.get<FileItem[]>(`/api/v1/files/breadcrumbs?folder_id=${folderId}`, signal)
        : Promise.resolve<FileItem[]>([]),
  })

  const { data: files, isLoading } = useQuery({
    queryKey: ['files', folderId],
    queryFn: ({ signal }) =>
      api.get<FileItem[]>(`/api/v1/files?${folderId ? `parent_id=${folderId}` : ''}`, signal),
  })

  const rename = useMutation({
    mutationFn: (body: { id: string; name: string }) =>
      api.patch(`/api/v1/files/${body.id}`, { name: body.name }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['files', folderId] }); setRenameId(null) },
    onError: () => toast.error('Rename failed'),
  })

  const trash = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/files/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['files', folderId] })
      void qc.invalidateQueries({ queryKey: ['me'] })
    },
    onError: () => toast.error('Move to trash failed'),
  })

  const createFolder = useMutation({
    mutationFn: (name: string) => api.post<FileItem>('/api/v1/files', { name, parent_id: folderId }),
    onSuccess: (newFolder) => {
      qc.setQueryData<FileItem[]>(['files', folderId], prev =>
        prev ? [...prev, newFolder] : [newFolder]
      )
    },
    onError: () => toast.error('Failed to create folder'),
  })

  useEffect(() => {
    if (user?.role === 'guest') void navigate({ to: '/shares', replace: true })
  }, [user, navigate])

  if (user?.role === 'guest') return null

  const handleSelect = useCallback((id: string, additive: boolean) => {
    setSelected(prev => {
      const next = new Set(additive ? prev : [])
      if (prev.has(id) && (additive || prev.size === 1)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleOpen = useCallback((item: FileItem) => {
    if (item.is_folder) void navigate({ to: '/files', search: { folder: item.id } })
    else setPreviewItem(item)
  }, [navigate])

  const handleContextMenuAction = useCallback((action: ContextAction, item: FileItem) => {
    switch (action) {
      case 'open': handleOpen(item); break
      case 'download':
        if (item.is_folder) setDownloadIds([item.id])
        else window.open(`/api/v1/files/${item.id}/download`, '_blank')
        break
      case 'share': setShareItem(item); break
      case 'rename': setRenameId(item.id); setRenameName(item.name); break
      case 'trash': if (confirm(`Move "${item.name}" to trash?`)) trash.mutate(item.id); break
    }
  }, [handleOpen, trash])

  const items = files ?? []
  const sorted = [...items.filter(f => f.is_folder), ...items.filter(f => !f.is_folder)]

  const currentFolderItem: FileItem | null = folderId && breadcrumbs?.length
    ? {
        id: folderId,
        parent_id: null,
        owner_id: '',
        is_folder: true,
        name: breadcrumbs[breadcrumbs.length - 1].name,
        mime_type: null,
        size_bytes: 0,
        checksum_sha256: null,
        deleted_at: null,
        created_at: '',
        updated_at: '',
        permissions: { can_view: true, can_upload: true, can_edit: true, can_delete: true, can_reshare: true, is_owner: true },
      }
    : null

  const handleSelectAll = useCallback(() => {
    if (selected.size === sorted.length) setSelected(new Set())
    else setSelected(new Set(sorted.map(f => f.id)))
  }, [selected.size, sorted])

  const handleBulkDownload = useCallback(() => {
    setDownloadIds([...selected])
  }, [selected])

  const handleBulkTrash = useCallback(async () => {
    if (!confirm(`Move ${selected.size} item(s) to trash?`)) return
    const results = await Promise.allSettled([...selected].map(id => api.delete(`/api/v1/files/${id}`)))
    const failed = results.filter(r => r.status === 'rejected').length
    if (failed > 0) toast.error(`${failed} item(s) could not be moved to trash`)
    void qc.invalidateQueries({ queryKey: ['files', folderId] })
    void qc.invalidateQueries({ queryKey: ['me'] })
    setSelected(new Set())
  }, [selected, qc, folderId])

  const handleCreatePlaylist = useCallback(async () => {
    const name = window.prompt('Playlist name:', 'My Playlist')
    if (!name?.trim()) return
    try {
      const f = await createPlaylist(name.trim(), folderId, [...selected])
      toast.success(`Playlist created`)
      void qc.invalidateQueries({ queryKey: ['files', folderId] })
      setSelected(new Set())
      window.dispatchEvent(new CustomEvent('open-preview', { detail: { id: f.id } }))
    } catch {
      toast.error('Failed to create playlist')
    }
  }, [selected, folderId, qc])

  return (
    <DropZone folderId={folderId} onUploadStart={startUpload}>
      <div className="flex flex-col flex-1 min-h-0">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-100 dark:border-[#2d3148] shrink-0">
          {selected.size > 0 ? (
            /* ── Bulk action bar ─────────────────────────────── */
            <>
              <button onClick={() => setSelected(new Set())} className="p-1 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300 transition-colors" title="Clear selection">
                <X size={16} />
              </button>
              <span className="text-sm font-medium text-zinc-900 dark:text-slate-100 flex-1">
                {selected.size} selected
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={handleBulkDownload}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                >
                  <Download size={12} />
                  Download
                </button>
                <button
                  onClick={() => { void handleCreatePlaylist() }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                  title="Create M3U playlist from selected audio files"
                >
                  <ListMusic size={12} />
                  Playlist
                </button>
                <button
                  onClick={() => { void handleBulkTrash() }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-red-200 dark:border-red-900/40 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                >
                  <Trash2 size={12} />
                  Delete
                </button>
              </div>
            </>
          ) : (
            /* ── Normal toolbar ──────────────────────────────── */
            <>
              <nav className="flex items-center gap-1 flex-1 min-w-0 text-sm">
                <button
                  onClick={() => void navigate({ to: '/files', search: {} })}
                  className="flex items-center gap-1 text-muted hover:text-zinc-900 dark:hover:text-slate-100 transition-colors shrink-0"
                >
                  <Home size={14} />
                  My Files
                </button>
                {breadcrumbs?.map(bc => (
                  <span key={bc.id} className="flex items-center gap-1">
                    <ChevronRight size={13} className="text-zinc-300 dark:text-slate-600 shrink-0" />
                    <button
                      onClick={() => void navigate({ to: '/files', search: { folder: bc.id } })}
                      className="text-muted hover:text-zinc-900 dark:hover:text-slate-100 transition-colors truncate max-w-[120px]"
                    >
                      {bc.name}
                    </button>
                  </span>
                ))}
              </nav>
              <div className="flex items-center gap-1 shrink-0">
                {folderId && currentFolderItem && (
                  <>
                    <button
                      onClick={() => setShareItem(currentFolderItem)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                    >
                      <Share2 size={12} />
                      Share
                    </button>
                    <button
                      onClick={() => { setRenameId(folderId); setRenameName(currentFolderItem.name) }}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                    >
                      <Pencil size={12} />
                      Rename
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm(`Move "${currentFolderItem.name}" to trash?`)) return
                        try {
                          await api.delete(`/api/v1/files/${folderId}`)
                          const parentId = breadcrumbs && breadcrumbs.length > 1
                            ? breadcrumbs[breadcrumbs.length - 2].id
                            : null
                          void qc.invalidateQueries({ queryKey: ['files', parentId] })
                          void qc.invalidateQueries({ queryKey: ['me'] })
                          void navigate({ to: '/files', search: parentId ? { folder: parentId } : {} })
                        } catch {
                          toast.error('Failed to delete folder')
                        }
                      }}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    >
                      <Trash2 size={12} />
                      Delete
                    </button>
                  </>
                )}
                <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium cursor-pointer transition-colors">
                  <Upload size={12} />
                  Upload
                  <input type="file" multiple className="sr-only" onChange={e => e.target.files && startUpload(Array.from(e.target.files))} />
                </label>
                <button
                  onClick={() => { const n = window.prompt('Folder name:'); if (n?.trim()) createFolder.mutate(n.trim()) }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                >
                  <FolderPlus size={12} />
                  New folder
                </button>
                <div className="flex items-center rounded-lg border border-zinc-200 dark:border-[#2d3148] overflow-hidden">
                  <button onClick={() => setView('list')} className={`p-1.5 transition-colors ${view === 'list' ? 'bg-zinc-100 dark:bg-[#2d3148] text-zinc-900 dark:text-slate-100' : 'text-zinc-400 hover:text-zinc-600'}`} title="List view"><LayoutList size={14} /></button>
                  <button onClick={() => setView('grid')} className={`p-1.5 transition-colors ${view === 'grid' ? 'bg-zinc-100 dark:bg-[#2d3148] text-zinc-900 dark:text-slate-100' : 'text-zinc-400 hover:text-zinc-600'}`} title="Grid view"><LayoutGrid size={14} /></button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-1" onClick={() => { setSelected(new Set()); setContextMenu(null) }}>
          {isLoading ? (
            <div className="flex items-center justify-center h-40 text-sm text-muted">Loading…</div>
          ) : view === 'list' ? (
            <FileList items={sorted} selectedIds={selected} onSelect={handleSelect} onOpen={handleOpen} onContextMenu={(item, x, y) => setContextMenu({ item, x, y })} onSelectAll={handleSelectAll} onQuickShare={item => setShareItem(item)} />
          ) : (
            <FileGrid items={sorted} selectedIds={selected} onSelect={handleSelect} onOpen={handleOpen} onContextMenu={(item, x, y) => setContextMenu({ item, x, y })} />
          )}
        </div>
      </div>

      {contextMenu && <FileContextMenu item={contextMenu.item} x={contextMenu.x} y={contextMenu.y} onAction={handleContextMenuAction} onClose={() => setContextMenu(null)} />}
      {shareItem && <ShareDialog item={shareItem} onClose={() => setShareItem(null)} />}
      {previewItem && <PreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />}
      {downloadIds && <DownloadDialog ids={downloadIds} onClose={() => setDownloadIds(null)} />}
      <UploadProgress uploads={uploads} onDismiss={dismiss} directUpload={directUpload} />

      {renameId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <form className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-5 w-80 space-y-3" onSubmit={e => { e.preventDefault(); rename.mutate({ id: renameId!, name: renameName }) }}>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">Rename</h3>
            <input autoFocus value={renameName} onChange={e => setRenameName(e.target.value)} className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setRenameId(null)} className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-muted">Cancel</button>
              <button type="submit" disabled={!renameName.trim() || rename.isPending} className="px-4 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium disabled:opacity-50">Rename</button>
            </div>
          </form>
        </div>
      )}
    </DropZone>
  )
}
