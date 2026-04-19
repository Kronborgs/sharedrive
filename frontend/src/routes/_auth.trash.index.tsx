import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useEffect } from 'react'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import type { FileItem, User } from '@/types/api'
import { FileList } from '@/components/files/FileViews'
import { FileContextMenu, type ContextAction } from '@/components/files/FileContextMenu'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'

export const Route = createFileRoute('/_auth/trash/')({
  component: TrashPage,
})

interface ContextState { item: FileItem; x: number; y: number }

function TrashPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  useEffect(() => {
    if (user?.role === 'guest') void navigate({ to: '/shares', replace: true })
  }, [user])
  if (user?.role === 'guest') return null
  const qc = useQueryClient()
  const { t } = useI18n()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextState | null>(null)

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => api.get<User>('/api/v1/me', signal),
  })
  const retentionDays = me?.trash_retention_days ?? 30

  const { data, isLoading } = useQuery({
    queryKey: ['files', 'trash'],
    queryFn: ({ signal }) => api.get<FileItem[]>('/api/v1/files/trash', signal),
  })

  const restore = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/files/trash/${id}/restore`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['files'] }),
    onError: () => toast.error(t('toast.restoreFailed')),
  })

  const deletePermanent = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/files/trash/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['files', 'trash'] }),
    onError: () => toast.error(t('toast.deleteFailed')),
  })

  const emptyTrash = useMutation({
    mutationFn: () => api.delete('/api/v1/files/trash'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['files', 'trash'] }),
    onError: () => toast.error(t('toast.emptyTrashFailed')),
  })

  const handleAction = (action: ContextAction, item: FileItem) => {
    if (action === 'restore') restore.mutate(item.id)
    else if (action === 'delete' && confirm(`Permanently delete "${item.name}"? This cannot be undone.`)) {
      deletePermanent.mutate(item.id)
    }
  }

  const items = data ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">{t('page.trash')}</h1>
        {items.length > 0 && (
          <button
            onClick={() => { if (confirm(t('confirm.emptyTrash'))) emptyTrash.mutate() }}
            disabled={emptyTrash.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
          >
            <Trash2 size={12} />
            {t('action.emptyTrash')}
          </button>
        )}
      </div>

      {items.length > 0 && (
        <p className="text-xs text-muted">
          {t('trash.autoDelete', { days: String(retentionDays) })}
        </p>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted">{t('files.loading')}</div>
      ) : (
        <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
          <FileList
            items={items}
            selectedIds={selected}
            onSelect={(id, add) => setSelected(prev => { const n = new Set(add ? prev : []); n.has(id) ? n.delete(id) : n.add(id); return n })}
            onOpen={() => {}}
            onContextMenu={(item, x, y) => setContextMenu({ item, x, y })}
          />
        </div>
      )}

      {contextMenu && (
        <FileContextMenu
          item={contextMenu.item}
          x={contextMenu.x}
          y={contextMenu.y}
          isTrash
          onAction={handleAction}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
