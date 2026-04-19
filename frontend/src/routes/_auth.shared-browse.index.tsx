import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useCallback } from 'react'
import { z } from 'zod'
import { api } from '@/lib/api'
import type { FileItem } from '@/types/api'
import { FileList } from '@/components/files/FileViews'
import { FileContextMenu, type ContextAction } from '@/components/files/FileContextMenu'
import { ShareDialog } from '@/components/files/ShareDialog'
import { DropZone, UploadProgress, useUploader } from '@/components/files/UploadZone'
import { PreviewModal } from '@/components/files/PreviewModal'
import { OnlyOfficeEditor } from '@/components/files/OnlyOfficeEditor'
import { ChevronRight, Users, Upload, FilePlus } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'

const searchSchema = z.object({
  folder: z.string(),
  root: z.string().optional(), // the original shared root folder id
})

export const Route = createFileRoute('/_auth/shared-browse/')({
  validateSearch: searchSchema,
  component: SharedBrowsePage,
})

interface ChildItem {
  id: string
  name: string
  is_folder: boolean
  size_bytes: number
  mime_type: string | null
}

interface ChildrenResponse {
  items: ChildItem[]
  can_view: boolean
  can_upload: boolean
  can_edit: boolean
  can_delete: boolean
  can_reshare: boolean
  owner_id: string
  folder_name: string
}

interface ContextMenuState {
  item: FileItem
  x: number
  y: number
}

function SharedBrowsePage() {
  const navigate = useNavigate()
  const { folder: folderId, root } = Route.useSearch()
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [shareItem, setShareItem] = useState<FileItem | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [previewItem, setPreviewItem] = useState<FileItem | null>(null)
  const [ooItem, setOoItem] = useState<FileItem | null>(null)
  const [newDocOpen, setNewDocOpen] = useState(false)
  const { t } = useI18n()

  const rootId = root ?? folderId

  const { uploads, startUpload, dismiss, directUpload } = useUploader(folderId, ['shared-browse', folderId])

  const { data: systemSettings } = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: ({ signal }) => api.get<{ direct_upload_url: string; onlyoffice_url: string }>('/api/v1/system/settings', signal),
    staleTime: 5 * 60 * 1000,
  })

  const { data, isLoading } = useQuery<ChildrenResponse>({
    queryKey: ['shared-browse', folderId],
    queryFn: ({ signal }) =>
      api.get<ChildrenResponse>(`/api/v1/files/shared/${folderId}/children`, signal),
    staleTime: 0,
  })

  const rename = useMutation({
    mutationFn: (body: { id: string; name: string }) =>
      api.patch(`/api/v1/files/${body.id}`, { name: body.name }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['shared-browse', folderId] }); setRenameId(null) },
    onError: () => toast.error(t('misc.renameFailed')),
  })

  const trash = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/files/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['shared-browse', folderId] }),
    onError: () => toast.error(t('misc.trashFailed')),
  })

  const items: FileItem[] = (data?.items ?? []).map(c => ({
    id: c.id,
    parent_id: folderId,
    owner_id: data?.owner_id ?? '',
    is_folder: c.is_folder,
    name: c.name,
    mime_type: c.mime_type,
    size_bytes: c.size_bytes,
    checksum_sha256: null,
    deleted_at: null,
    created_at: '',
    updated_at: '',
    shared: true,
    permissions: {
      can_view: data?.can_view ?? true,
      can_upload: data?.can_upload ?? false,
      can_edit: data?.can_edit ?? false,
      can_delete: data?.can_delete ?? false,
      can_reshare: data?.can_reshare ?? false,
      is_owner: false,
    },
  }))

  const handleOpen = useCallback((item: FileItem) => {
    if (item.is_folder) {
      void navigate({ to: '/shared-browse', search: { folder: item.id, root: rootId } })
      return
    }
    if (systemSettings?.onlyoffice_url) {
      const ext = item.name.split('.').pop()?.toLowerCase() ?? ''
      const ooFormats = new Set(['doc','docx','docm','dot','dotx','rtf','odt','ott','txt','xml',
        'xls','xlsx','xlsm','xlsb','xltx','csv','ods','ots','fods',
        'ppt','pptx','pptm','potx','odp','otp','fodp'])
      if (ooFormats.has(ext)) {
        setOoItem(item)
        return
      }
    }
    setPreviewItem(item)
  }, [navigate, rootId, systemSettings])

  const handleSelect = useCallback((id: string, additive: boolean) => {
    setSelected(prev => {
      const next = new Set(additive ? prev : [])
      if (prev.has(id) && (additive || prev.size === 1)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleContextMenuAction = useCallback((action: ContextAction, item: FileItem) => {
    switch (action) {
      case 'open': handleOpen(item); break
      case 'download': window.open(`/api/v1/files/${item.id}/download`, '_blank'); break
      case 'share': setShareItem(item); break
      case 'rename': setRenameId(item.id); setRenameName(item.name); break
      case 'trash': if (confirm(`Move "${item.name}" to trash?`)) trash.mutate(item.id); break
    }
  }, [handleOpen, trash])

  // Compute which context menu actions are available based on share permissions
  const allowedActions: ContextAction[] = ['open', 'download']
  if (data?.can_edit) allowedActions.push('rename')
  if (data?.can_delete) allowedActions.push('trash')
  if (data?.can_reshare) allowedActions.push('share')

  const createDocument = useMutation({
    mutationFn: (opts: { type: 'word' | 'cell' | 'slide'; name: string }) =>
      api.post<{ id: string; name: string }>('/api/v1/onlyoffice/create', {
        type: opts.type,
        name: opts.name,
        parent_id: folderId,
      }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ['shared-browse', folderId] })
      setNewDocOpen(false)
      const pseudo: FileItem = {
        id: result.id,
        name: result.name,
        is_folder: false,
        parent_id: folderId,
        owner_id: data?.owner_id ?? '',
        mime_type: null,
        size_bytes: 0,
        checksum_sha256: null,
        deleted_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        shared: true,
        permissions: undefined,
      }
      setOoItem(pseudo)
    },
    onError: () => toast.error(t('toast.createDocFailed')),
  })

  return (
    <DropZone folderId={folderId} onUploadStart={startUpload}>
      <div className="flex flex-col flex-1 min-h-0">
        {/* Toolbar / breadcrumb */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-100 dark:border-[#2d3148] shrink-0">
          <nav className="flex items-center gap-1 flex-1 min-w-0 text-sm">
            <button
              onClick={() => void navigate({ to: '/shares' })}
              className="flex items-center gap-1 text-muted hover:text-zinc-900 dark:hover:text-slate-100 transition-colors shrink-0"
            >
              <Users size={14} />
              {t('shared.sharedWithMe')}
            </button>
            {rootId !== folderId && (
              <>
                <ChevronRight size={13} className="text-zinc-300 dark:text-slate-600 shrink-0" />
                <button
                  onClick={() => void navigate({ to: '/shared-browse', search: { folder: rootId } })}
                  className="text-muted hover:text-zinc-900 dark:hover:text-slate-100 transition-colors truncate max-w-[120px]"
                >
                  …
                </button>
              </>
            )}
            <ChevronRight size={13} className="text-zinc-300 dark:text-slate-600 shrink-0" />
            <span className="text-zinc-900 dark:text-slate-100 truncate max-w-[160px]">
              {data?.folder_name ?? '…'}
            </span>
          </nav>
          {data?.can_upload && (
            <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium cursor-pointer transition-colors shrink-0">
              <Upload size={12} />
              {t('action.upload')}
              <input type="file" multiple className="sr-only" onChange={e => e.target.files && startUpload(Array.from(e.target.files))} />
            </label>
          )}
          {data?.can_edit && systemSettings?.onlyoffice_url && (
            <div className="relative">
              <button
                onClick={() => setNewDocOpen(v => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors shrink-0"
              >
                <FilePlus size={12} />
                {t('action.newDoc')}
              </button>
              {newDocOpen && (
                <div className="absolute right-0 top-full mt-1 w-44 rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] shadow-xl z-40 py-1">
                  {([
                    { type: 'word' as const,  icon: '📄', labelKey: 'doc.word' as const,       nameKey: 'doc.wordName' as const,       ext: '.docx' },
                    { type: 'cell' as const,  icon: '📊', labelKey: 'doc.excel' as const,      nameKey: 'doc.excelName' as const,      ext: '.xlsx' },
                    { type: 'slide' as const, icon: '📑', labelKey: 'doc.powerpoint' as const, nameKey: 'doc.powerpointName' as const, ext: '.pptx' },
                  ] as const).map(o => (
                    <button
                      key={o.type}
                      onClick={() => { createDocument.mutate({ type: o.type, name: `${t(o.nameKey)}${o.ext}` }) }}
                      disabled={createDocument.isPending}
                      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-50"
                    >
                      <span>{o.icon}</span>
                      {t(o.labelKey)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-1" onClick={() => { setSelected(new Set()); setContextMenu(null) }}>
          {isLoading ? (
            <div className="flex items-center justify-center h-40 text-sm text-muted">{t('files.loading')}</div>
          ) : (
            <FileList
              items={items}
              selectedIds={selected}
              onSelect={handleSelect}
              onOpen={handleOpen}
              onContextMenu={(item, x, y) => setContextMenu({ item, x, y })}
            />
          )}
        </div>
      </div>

      {contextMenu && (
        <FileContextMenu
          item={contextMenu.item}
          x={contextMenu.x}
          y={contextMenu.y}
          allowedActions={allowedActions}
          onAction={handleContextMenuAction}
          onClose={() => setContextMenu(null)}
        />
      )}
      {shareItem && <ShareDialog item={shareItem} onClose={() => setShareItem(null)} />}
      {previewItem && <PreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />}
      {ooItem && systemSettings?.onlyoffice_url && (
        <OnlyOfficeEditor
          item={ooItem}
          onlyofficeUrl={systemSettings.onlyoffice_url}
          backLabel={t('shared.sharedWithMe')}
          onClose={() => setOoItem(null)}
        />
      )}
      <UploadProgress uploads={uploads} onDismiss={dismiss} directUpload={directUpload} />

      {renameId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <form
            className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-5 w-80 space-y-3"
            onSubmit={e => { e.preventDefault(); rename.mutate({ id: renameId!, name: renameName }) }}
          >
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">{t('action.rename')}</h3>
            <input
              autoFocus
              value={renameName}
              onChange={e => setRenameName(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setRenameId(null)} className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-muted">{t('action.cancel')}</button>
              <button type="submit" disabled={!renameName.trim() || rename.isPending} className="px-4 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium disabled:opacity-50">{t('action.rename')}</button>
            </div>
          </form>
        </div>
      )}
    </DropZone>
  )
}
