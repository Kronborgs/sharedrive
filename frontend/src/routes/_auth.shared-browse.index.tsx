import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState, useCallback } from 'react'
import { z } from 'zod'
import { api } from '@/lib/api'
import type { FileItem } from '@/types/api'
import { FileList } from '@/components/files/FileViews'
import { ChevronRight, Users } from 'lucide-react'

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

function SharedBrowsePage() {
  const navigate = useNavigate()
  const { folder: folderId, root } = Route.useSearch()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const rootId = root ?? folderId

  const { data, isLoading } = useQuery<ChildrenResponse>({
    queryKey: ['shared-browse', folderId],
    queryFn: ({ signal }) =>
      api.get<ChildrenResponse>(`/api/v1/files/shared/${folderId}/children`, signal),
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
    } else {
      window.open(`/api/v1/files/${item.id}/download`, '_blank')
    }
  }, [navigate, rootId])

  const handleSelect = useCallback((id: string, additive: boolean) => {
    setSelected(prev => {
      const next = new Set(additive ? prev : [])
      if (prev.has(id) && (additive || prev.size === 1)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar / breadcrumb */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-100 dark:border-[#2d3148] shrink-0">
        <nav className="flex items-center gap-1 flex-1 min-w-0 text-sm">
          <button
            onClick={() => void navigate({ to: '/shares' })}
            className="flex items-center gap-1 text-muted hover:text-zinc-900 dark:hover:text-slate-100 transition-colors shrink-0"
          >
            <Users size={14} />
            Shared with me
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
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-1" onClick={() => setSelected(new Set())}>
        {isLoading ? (
          <div className="flex items-center justify-center h-40 text-sm text-muted">Loading…</div>
        ) : (
          <FileList
            items={items}
            selectedIds={selected}
            onSelect={handleSelect}
            onOpen={handleOpen}
            onContextMenu={() => {}}
          />
        )}
      </div>
    </div>
  )
}
