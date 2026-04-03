import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { FileItem, Share } from '@/types/api'
import { FileList } from '@/components/files/FileViews'
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { formatDate } from '@/lib/utils'

export const Route = createFileRoute('/_auth/shares/')({
  component: SharedWithMePage,
})

interface SharedItem {
  share: Share
  item: FileItem
}

function SharedWithMePage() {
  const navigate = useNavigate()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const { data, isLoading } = useQuery({
    queryKey: ['files', 'shared-with-me'],
    queryFn: ({ signal }) => api.get<SharedItem[]>('/api/v1/shares/with-me', signal),
  })

  const items = data?.map(s => s.item) ?? []

  const handleOpen = (item: FileItem) => {
    if (item.is_folder) void navigate({ to: '/files', search: { folder: item.id } })
    else window.open(`/api/v1/files/${item.id}/download`, '_blank')
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">Shared with me</h1>
      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted">Loading…</div>
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
