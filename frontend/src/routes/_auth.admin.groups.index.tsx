import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import type { Group } from '@/types/api'
import { Pencil, Trash2, Plus } from 'lucide-react'

export const Route = createFileRoute('/_auth/admin/groups/')({
  component: GroupsPage,
})

const COLORS = [
  '#6b7280', '#ef4444', '#f97316', '#eab308',
  '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
]

function GroupsPage() {
  const qc = useQueryClient()
  const [name, setName]   = useState('')
  const [color, setColor] = useState(COLORS[0])
  const [editId, setEditId]     = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')

  const { data: groups, isLoading } = useQuery({
    queryKey: ['admin', 'groups'],
    queryFn: ({ signal }) => api.get<Group[]>('/api/v1/admin/groups', signal),
  })

  const create = useMutation({
    mutationFn: () => api.post<Group>('/api/v1/admin/groups', { name, color }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'groups'] }); setName('') },
  })

  const update = useMutation({
    mutationFn: () => api.patch(`/api/v1/admin/groups/${editId}`, { name: editName, color: editColor }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin', 'groups'] }); setEditId(null) },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/groups/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'groups'] }),
  })

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">Groups</h1>

      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
        {/* Create form */}
        <form
          onSubmit={e => { e.preventDefault(); create.mutate(undefined) }}
          className="px-4 py-3 border-b border-zinc-100 dark:border-[#2d3148] flex gap-2 flex-wrap items-end"
        >
          <div className="flex-1 min-w-[150px] space-y-1">
            <label className="text-xs text-muted uppercase tracking-wide font-medium">Group name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="New group…"
              className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted uppercase tracking-wide font-medium">Color</label>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors shrink-0"
          >
            <Plus size={14} />
            Create
          </button>
        </form>

        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted">Loading…</div>
        ) : (groups?.length ?? 0) === 0 ? (
          <div className="p-8 text-center text-sm text-muted">No groups yet</div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
            {groups?.map(g => (
              <li key={g.id} className="flex items-center gap-3 px-4 py-3">
                {/* Color dot */}
                <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-white text-xs font-bold"
                  style={{ backgroundColor: g.color }}>
                  {g.name[0]?.toUpperCase()}
                </div>

                {editId === g.id ? (
                  <form className="flex gap-2 flex-1 flex-wrap items-center"
                    onSubmit={e => { e.preventDefault(); update.mutate(undefined) }}>
                    <input
                      autoFocus
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      className="flex-1 min-w-[120px] rounded-lg border border-brand-400 bg-zinc-50 dark:bg-[#0f1117] px-3 py-1 text-sm text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <ColorPicker value={editColor} onChange={setEditColor} />
                    <button type="submit" disabled={!editName.trim() || update.isPending}
                      className="px-3 py-1 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium">
                      Save
                    </button>
                    <button type="button" onClick={() => setEditId(null)}
                      className="px-3 py-1 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-muted hover:bg-zinc-50 dark:hover:bg-[#2d3148]">
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-900 dark:text-slate-100">{g.name}</p>
                      {g.description && <p className="text-xs text-muted">{g.description}</p>}
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => { setEditId(g.id); setEditName(g.name); setEditColor(g.color) }}
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300 hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors"
                        title="Edit">
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => { if (confirm(`Delete group "${g.name}"?`)) remove.mutate(g.id) }}
                        className="p-1.5 rounded-lg text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        title="Delete">
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

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {COLORS.map(c => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`w-5 h-5 rounded-full transition-transform ${value === c ? 'ring-2 ring-offset-2 ring-zinc-400 dark:ring-slate-500 scale-110' : 'hover:scale-110'}`}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  )
}

