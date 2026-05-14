import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import type { Tag } from '@/types/api'
import { Pencil, Trash2, Plus } from 'lucide-react'
import { useI18n } from '@/lib/i18n'

export const Route = createFileRoute('/_auth/admin/tags/')({
  component: TagsPage,
})

const PRESET_COLORS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#ec4899',
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#14b8a6', '#06b6d4', '#3b82f6', '#64748b',
]

function TagsPage() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [color, setColor] = useState(PRESET_COLORS[0])
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')
  const { t } = useI18n()

  const { data: tags, isLoading } = useQuery({
    queryKey: ['admin', 'tags'],
    queryFn: ({ signal }) => api.get<Tag[]>('/api/v1/admin/tags', signal),
  })

  const create = useMutation({
    mutationFn: () => api.post<Tag>('/api/v1/admin/tags', { name, color }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'tags'] })
      setName('')
      setColor(PRESET_COLORS[0])
    },
  })

  const update = useMutation({
    mutationFn: () => api.patch(`/api/v1/admin/tags/${editId}`, { name: editName, color: editColor }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'tags'] }); setEditId(null) },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/tags/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'tags'] }) },
  })

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">{t('tags.title')}</h1>
      <p className="text-sm text-muted">
        {t('tags.desc')}
      </p>

      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
        {/* Create form */}
        <form
          onSubmit={e => { e.preventDefault(); create.mutate(undefined) }}
          className="px-4 py-3 border-b border-zinc-100 dark:border-[#2d3148] flex flex-wrap gap-2 items-center"
        >
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('tags.placeholder')}
            className="flex-1 min-w-[140px] rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <div className="flex gap-1">
            {PRESET_COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 ${color === c ? 'border-white dark:border-slate-200 scale-110' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
          </div>
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            <Plus size={14} />
            {t('tags.create')}
          </button>
        </form>

        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted">{t('tags.loading')}</div>
        ) : tags?.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted">{t('tags.noTags')}</div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
            {tags?.map(tag => (
              <li key={tag.id} className="flex items-center gap-3 px-4 py-3">
                {editId === tag.id ? (
                  <form
                    className="flex flex-wrap gap-2 flex-1 items-center"
                    onSubmit={e => { e.preventDefault(); update.mutate(undefined) }}
                  >
                    <input
                      autoFocus
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      className="flex-1 rounded-lg border border-brand-400 bg-zinc-50 dark:bg-[#0f1117] px-3 py-1 text-sm text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <div className="flex gap-1">
                      {PRESET_COLORS.map(c => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setEditColor(c)}
                          className={`w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 ${editColor === c ? 'border-white dark:border-slate-200 scale-110' : 'border-transparent'}`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                    <button type="submit" disabled={!editName.trim()} className="px-3 py-1 rounded-lg bg-brand-600 text-white text-sm font-medium">{t('tags.editTitle')}</button>
                    <button type="button" onClick={() => setEditId(null)} className="px-3 py-1 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-muted">{t('users.cancel')}</button>
                  </form>
                ) : (
                  <>
                    <span
                      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium text-white"
                      style={{ backgroundColor: tag.color }}
                    >
                      {tag.name}
                    </span>
                    <span className="text-xs text-muted">{tag.color}</span>
                    <div className="ml-auto flex items-center gap-1">
                      <button
                        onClick={() => { setEditId(tag.id); setEditName(tag.name); setEditColor(tag.color) }}
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300 hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors"
                        title={t('tags.editTitle')}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => { if (confirm(t('tags.deleteConfirm', { name: tag.name }))) remove.mutate(tag.id) }}
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        title={t('tags.deleteTitle')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
