import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import type { Tag } from '@/types/api'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'

export const Route = createFileRoute('/_auth/admin/tags/')({
  component: TagsPage,
})

const PRESET_COLORS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#ec4899',
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#14b8a6', '#06b6d4', '#3b82f6', '#64748b',
]

function ColorPicker({
  selectedColor,
  onSelect,
}: Readonly<{
  selectedColor: string
  onSelect: (color: string) => void
}>) {
  return (
    <div className="flex gap-1">
      {PRESET_COLORS.map(color => (
        <button
          key={color}
          type="button"
          onClick={() => onSelect(color)}
          className={`w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 ${selectedColor === color ? 'border-white dark:border-slate-200 scale-110' : 'border-transparent'}`}
          style={{ backgroundColor: color }}
          title={color}
        />
      ))}
    </div>
  )
}

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
      ignorePromise(qc.invalidateQueries({ queryKey: ['admin', 'tags'] }))
      setName('')
      setColor(PRESET_COLORS[0])
    },
  })

  const update = useMutation({
    mutationFn: () => api.patch(`/api/v1/admin/tags/${editId}`, { name: editName, color: editColor }),
    onSuccess: () => {
      ignorePromise(qc.invalidateQueries({ queryKey: ['admin', 'tags'] }))
      setEditId(null)
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/tags/${id}`),
    onSuccess: () => {
      ignorePromise(qc.invalidateQueries({ queryKey: ['admin', 'tags'] }))
    },
  })

  const startEdit = (tag: Tag) => {
    setEditId(tag.id)
    setEditName(tag.name)
    setEditColor(tag.color)
  }

  const renderTags = () => {
    if (isLoading) {
      return <div className="p-8 text-center text-sm text-muted">{t('tags.loading')}</div>
    }
    if (tags?.length === 0) {
      return <div className="p-8 text-center text-sm text-muted">{t('tags.noTags')}</div>
    }
    return (
      <ul className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
        {tags?.map(tag => (
          <li key={tag.id} className="flex items-center gap-3 px-4 py-3">
            {editId === tag.id ? (
              <form
                className="flex flex-wrap gap-2 flex-1 items-center"
                onSubmit={e => {
                  e.preventDefault()
                  update.mutate(undefined)
                }}
              >
                <input
                  autoFocus
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  className="flex-1 rounded-lg border border-brand-400 bg-zinc-50 dark:bg-[#0f1117] px-3 py-1 text-sm text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <ColorPicker selectedColor={editColor} onSelect={setEditColor} />
                <button type="submit" className="px-3 py-1 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm">Save</button>
                <button type="button" onClick={() => setEditId(null)} className="px-3 py-1 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-muted">Cancel</button>
              </form>
            ) : (
              <>
                <span className="w-4 h-4 rounded-full" style={{ backgroundColor: tag.color }} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-zinc-900 dark:text-slate-100">{tag.name}</div>
                  <div className="text-xs text-muted">{tag.color}</div>
                </div>
                <button
                  onClick={() => startEdit(tag)}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/20 transition-colors"
                  title="Edit tag"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => remove.mutate(tag.id)}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  title="Delete tag"
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">{t('tags.title')}</h1>
      <p className="text-sm text-muted">
        {t('tags.desc')}
      </p>

      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
        <form
          onSubmit={e => {
            e.preventDefault()
            create.mutate(undefined)
          }}
          className="px-4 py-3 border-b border-zinc-100 dark:border-[#2d3148] flex flex-wrap gap-2 items-center"
        >
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('tags.placeholder')}
            className="flex-1 min-w-[140px] rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <ColorPicker selectedColor={color} onSelect={setColor} />
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            <Plus size={14} />
            {t('tags.create')}
          </button>
        </form>

        {renderTags()}
      </div>
    </div>
  )
}