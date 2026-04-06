import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { FileItem } from '@/types/api'
import { FileList } from '@/components/files/FileViews'
import { useState, useEffect } from 'react'
import { useAuth } from '@/lib/auth-context'

export const Route = createFileRoute('/_auth/recent/')({
  component: RecentPage,
})

function RecentPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  useEffect(() => {
    if (user?.role === 'guest') void navigate({ to: '/shares', replace: true })
  }, [user])
  if (user?.role === 'guest') return null
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const { data, isLoading } = useQuery({
    queryKey: ['files', 'recent'],
    queryFn: ({ signal }) => api.get<FileItem[]>('/api/v1/files/recent', signal),
  })

  const handleOpen = (item: FileItem) => {
    if (item.is_folder) void navigate({ to: '/files', search: { folder: item.id } })
    else window.open(`/api/v1/files/${item.id}/download`, '_blank')
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">Recent</h1>
      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted">Loading…</div>
      ) : (
        <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
          <FileList
            items={data ?? []}
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
