import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Share } from '@/types/api'
import { FileList } from '@/components/files/FileViews'
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { PreviewModal } from '@/components/files/PreviewModal'
import { OnlyOfficeEditor } from '@/components/files/OnlyOfficeEditor'
import { TextEditor } from '@/components/files/TextEditor'
import { shouldOpenInOnlyOffice, shouldOpenInTextEditor } from '@/lib/file-types'
import type { FileItem } from '@/types/api'
import { useI18n } from '@/lib/i18n'
import { Folder, File, Eye, Upload, Pencil, Trash2, Share2, Link, Users, Clock, X } from 'lucide-react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_auth/shares/')({
  component: SharedPage,
})

interface SharedFileItem {
  id: string
  name: string
  is_folder: boolean
  size_bytes: number
  mime_type: string | null
  created_at: string
}

interface SharedItem {
  share: Share
  item: SharedFileItem
}

interface MyShareEntry {
  id: string
  resource_id: string
  owner_id: string
  grantee_type: 'user' | 'group' | 'link'
  grantee_id?: string
  grantee_email?: string
  grantee_group_name?: string
  pending_email?: string
  token?: string
  can_view: boolean
  can_upload: boolean
  can_edit: boolean
  can_delete: boolean
  can_reshare: boolean
  expires_at?: string
  created_at: string
}

interface MyShareGroup {
  item: SharedFileItem
  shares: MyShareEntry[]
}

function SharedPage() {
  const [tab, setTab] = useState<'received' | 'sent'>('received')
  const { t } = useI18n()

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">{t('shared.sharedWithMe')}</h1>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-zinc-200 dark:border-[#2d3148]">
        <button
          onClick={() => setTab('received')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'received'
              ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
              : 'border-transparent text-zinc-500 dark:text-slate-400 hover:text-zinc-800 dark:hover:text-slate-200'
          }`}
        >
          {t('shared.sharedWithMe')}
        </button>
        <button
          onClick={() => setTab('sent')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'sent'
              ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
              : 'border-transparent text-zinc-500 dark:text-slate-400 hover:text-zinc-800 dark:hover:text-slate-200'
          }`}
        >
          {t('shared.myShares')}
        </button>
      </div>

      {tab === 'received' ? <ReceivedTab /> : <SentTab />}
    </div>
  )
}

function ReceivedTab() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [previewItem, setPreviewItem] = useState<FileItem | null>(null)
  const [ooItem, setOoItem] = useState<FileItem | null>(null)
  const [teItem, setTeItem] = useState<FileItem | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['files', 'shared-with-me'],
    queryFn: ({ signal }) => api.get<SharedItem[]>('/api/v1/files/shared-with-me', signal),
    staleTime: 0,
  })

  const { data: systemSettings } = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: ({ signal }) => api.get<{ onlyoffice_url?: string }>('/api/v1/system/settings', signal),
    staleTime: 5 * 60 * 1000,
  })

  const items = (data ?? []).map(s => ({
    id: s.item.id,
    parent_id: null,
    owner_id: s.share.owner_id,
    is_folder: s.item.is_folder,
    name: s.item.name,
    mime_type: s.item.mime_type,
    size_bytes: s.item.size_bytes,
    checksum_sha256: null,
    deleted_at: null,
    created_at: s.item.created_at,
    updated_at: s.item.created_at,
    shared: true,
    permissions: {
      can_view: s.share.can_view,
      can_upload: s.share.can_upload,
      can_edit: s.share.can_edit,
      can_delete: s.share.can_delete,
      can_reshare: s.share.can_reshare,
      is_owner: false,
    },
  }))

  const handleOpen = (item: FileItem) => {
    if (item.is_folder) void navigate({ to: '/shared-browse', search: { folder: item.id } })
    else if (systemSettings?.onlyoffice_url && shouldOpenInOnlyOffice(item.name)) {
      setOoItem(item)
    } else if (shouldOpenInTextEditor(item.name)) {
      setTeItem(item)
    } else {
      setPreviewItem(item)
    }
  }

  return (
    <>
      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-sm text-zinc-400 dark:text-slate-500">{t('files.loading')}</div>
      ) : items.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-sm text-zinc-400 dark:text-slate-500">{t('files.nothingShared')}</div>
      ) : (
        <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
          <FileList
            items={items}
            selectedIds={selected}
            onSelect={(id, add) => setSelected(prev => { const n = new Set(add ? prev : []); n.has(id) ? n.delete(id) : n.add(id); return n })}
            onOpen={handleOpen}
            onContextMenu={() => {}}
          />
        </div>
      )}
      {previewItem && <PreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />}
      {ooItem && systemSettings?.onlyoffice_url && (
        <OnlyOfficeEditor
          item={ooItem}
          onlyofficeUrl={systemSettings.onlyoffice_url}
          backLabel={t('shared.sharedWithMe')}
          onClose={() => setOoItem(null)}
        />
      )}
      {teItem && (
        <TextEditor item={teItem} onClose={() => setTeItem(null)} />
      )}
    </>
  )
}

function SentTab() {
  const { t } = useI18n()
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['files', 'my-shares'],
    queryFn: ({ signal }) => api.get<MyShareGroup[]>('/api/v1/files/my-shares', signal),
    staleTime: 0,
  })

  const revoke = useMutation({
    mutationFn: (shareId: string) => api.delete(`/api/v1/shares/${shareId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['files', 'my-shares'] })
      toast.success(t('shared.revokeShare'))
    },
  })

  const handleRevoke = (shareId: string) => {
    if (!confirm(t('shared.revokeConfirm'))) return
    revoke.mutate(shareId)
  }

  if (isLoading) {
    return <div className="flex items-center justify-center h-40 text-sm text-zinc-400 dark:text-slate-500">{t('files.loading')}</div>
  }

  if (!data || data.length === 0) {
    return <div className="flex items-center justify-center h-40 text-sm text-zinc-400 dark:text-slate-500">{t('shared.noShares')}</div>
  }

  return (
    <div className="space-y-3">
      {data.map(group => (
        <div key={group.item.id} className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
          {/* File/folder header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-100 dark:border-[#2d3148]">
            {group.item.is_folder
              ? <Folder className="w-4 h-4 text-indigo-400 shrink-0" />
              : <File className="w-4 h-4 text-zinc-400 dark:text-slate-500 shrink-0" />
            }
            <span className="font-medium text-sm text-zinc-900 dark:text-slate-100 truncate">{group.item.name}</span>
            <span className="ml-auto text-xs text-zinc-400 dark:text-slate-500 shrink-0">
              {t('shared.sharesCount', { n: String(group.shares.length) })}
            </span>
          </div>

          {/* Share rows */}
          <div className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
            {group.shares.map(s => (
              <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                {/* Grantee icon */}
                {s.grantee_type === 'link'
                  ? <Link className="w-4 h-4 text-amber-400 shrink-0" />
                  : s.grantee_type === 'group'
                  ? <Users className="w-4 h-4 text-purple-400 shrink-0" />
                  : <div className="w-5 h-5 rounded-full bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center shrink-0">
                      <span className="text-[9px] font-bold text-indigo-600 dark:text-indigo-400 uppercase">
                        {(s.grantee_email ?? s.pending_email ?? '?')[0]}
                      </span>
                    </div>
                }

                {/* Who */}
                <div className="flex-1 min-w-0">
                  {s.grantee_type === 'link' ? (
                    <span className="text-sm text-zinc-600 dark:text-slate-300">{t('shared.publicLink')}</span>
                  ) : s.grantee_type === 'group' ? (
                    <span className="text-sm text-zinc-600 dark:text-slate-300">{s.grantee_group_name}</span>
                  ) : s.pending_email ? (
                    <span className="text-sm text-zinc-400 dark:text-slate-500 italic">{s.pending_email} — {t('shared.pendingInvite')}</span>
                  ) : (
                    <span className="text-sm text-zinc-600 dark:text-slate-300">{s.grantee_email}</span>
                  )}
                  {s.expires_at && (
                    <div className="flex items-center gap-1 text-xs text-zinc-400 dark:text-slate-500 mt-0.5">
                      <Clock className="w-3 h-3" />
                      {t('shared.expires')} {new Date(s.expires_at).toLocaleDateString()}
                    </div>
                  )}
                </div>

                {/* Permission badges */}
                <div className="flex items-center gap-1 shrink-0">
                  {s.can_view    && <Eye    className="w-3.5 h-3.5 text-zinc-400 dark:text-slate-500" title="Vis" />}
                  {s.can_upload  && <Upload className="w-3.5 h-3.5 text-blue-400" title="Upload" />}
                  {s.can_edit    && <Pencil className="w-3.5 h-3.5 text-green-400" title="Rediger" />}
                  {s.can_delete  && <Trash2 className="w-3.5 h-3.5 text-red-400" title="Slet" />}
                  {s.can_reshare && <Share2 className="w-3.5 h-3.5 text-purple-400" title="Del videre" />}
                </div>

                {/* Revoke button */}
                <button
                  onClick={() => handleRevoke(s.id)}
                  disabled={revoke.isPending}
                  className="ml-2 p-1 rounded text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors shrink-0"
                  title={t('shared.revokeShare')}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}


interface SharedFileItem {
  id: string
  name: string
  is_folder: boolean
  size_bytes: number
  mime_type: string | null
  created_at: string
}

interface SharedItem {
  share: Share
  item: SharedFileItem
}

function SharedWithMePage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [previewItem, setPreviewItem] = useState<FileItem | null>(null)
  const [ooItem, setOoItem] = useState<FileItem | null>(null)
  const [teItem, setTeItem] = useState<FileItem | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['files', 'shared-with-me'],
    queryFn: ({ signal }) => api.get<SharedItem[]>('/api/v1/files/shared-with-me', signal),
    staleTime: 0,
  })

  const { data: systemSettings } = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: ({ signal }) => api.get<{ onlyoffice_url?: string }>('/api/v1/system/settings', signal),
    staleTime: 5 * 60 * 1000,
  })

  // Convert to FileItem shape that FileList understands
  const items = (data ?? []).map(s => ({
    id: s.item.id,
    parent_id: null,
    owner_id: s.share.owner_id,
    is_folder: s.item.is_folder,
    name: s.item.name,
    mime_type: s.item.mime_type,
    size_bytes: s.item.size_bytes,
    checksum_sha256: null,
    deleted_at: null,
    created_at: s.item.created_at,
    updated_at: s.item.created_at,
    shared: true,
    permissions: {
      can_view: s.share.can_view,
      can_upload: s.share.can_upload,
      can_edit: s.share.can_edit,
      can_delete: s.share.can_delete,
      can_reshare: s.share.can_reshare,
      is_owner: false,
    },
  }))

  const handleOpen = (item: FileItem) => {
    if (item.is_folder) void navigate({ to: '/shared-browse', search: { folder: item.id } })
    else if (systemSettings?.onlyoffice_url && shouldOpenInOnlyOffice(item.name)) {
      setOoItem(item)
    } else if (shouldOpenInTextEditor(item.name)) {
      setTeItem(item)
    } else {
      setPreviewItem(item)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">{t('shared.sharedWithMe')}</h1>
      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted">{t('files.loading')}</div>
      ) : items.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted">{t('files.nothingShared')}</div>
      ) : (
        <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
          <FileList
            items={items}
            selectedIds={selected}
            onSelect={(id, add) => setSelected(prev => { const n = new Set(add ? prev : []); n.has(id) ? n.delete(id) : n.add(id); return n })}
            onOpen={handleOpen}
            onContextMenu={() => {}}
          />
        </div>
      )}
      {previewItem && <PreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />}
      {ooItem && systemSettings?.onlyoffice_url && (
        <OnlyOfficeEditor
          item={ooItem}
          onlyofficeUrl={systemSettings.onlyoffice_url}
          backLabel={t('shared.sharedWithMe')}
          onClose={() => setOoItem(null)}
        />
      )}
      {teItem && (
        <TextEditor
          item={teItem}
          onClose={() => setTeItem(null)}
        />
      )}
    </div>
  )
}

