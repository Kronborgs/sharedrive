import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Share } from '@/types/api'
import { FileList } from '@/components/files/FileViews'
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { PreviewModal } from '@/components/files/PreviewModal'
import { OnlyOfficeEditor } from '@/components/files/OnlyOfficeEditor'
import type { FileItem } from '@/types/api'

const ooFormats = new Set(['doc','docx','docm','dot','dotx','rtf','odt','ott','txt','xml',
  'xls','xlsx','xlsm','xlsb','xltx','csv','ods','ots','fods',
  'ppt','pptx','pptm','potx','odp','otp','fodp'])

export const Route = createFileRoute('/_auth/shares/')({
  component: SharedWithMePage,
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

function SharedWithMePage() {
  const navigate = useNavigate()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [previewItem, setPreviewItem] = useState<FileItem | null>(null)
  const [ooItem, setOoItem] = useState<FileItem | null>(null)

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
    else if (systemSettings?.onlyoffice_url) {
      const ext = item.name.split('.').pop()?.toLowerCase() ?? ''
      if (ooFormats.has(ext)) { setOoItem(item); return }
      setPreviewItem(item)
    } else {
      setPreviewItem(item)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">Shared with me</h1>
      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted">Loading…</div>
      ) : items.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted">Nothing has been shared with you yet.</div>
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
          backLabel="Delt med mig"
          onClose={() => setOoItem(null)}
        />
      )}
    </div>
  )
}

