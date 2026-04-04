import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Share } from '@/types/api'
import { FileList } from '@/components/files/FileViews'
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'

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

  const { data, isLoading } = useQuery({
    queryKey: ['files', 'shared-with-me'],
    queryFn: ({ signal }) => api.get<SharedItem[]>('/api/v1/files/shared-with-me', signal),
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

  const handleOpen = (item: { id: string; is_folder: boolean }) => {
    if (item.is_folder) void navigate({ to: '/shared-browse', search: { folder: item.id } })
    else window.open(`/api/v1/files/${item.id}/download`, '_blank')
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
    </div>
  )
}

