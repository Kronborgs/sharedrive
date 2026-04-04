import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { X, Plus, Pencil, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { User, Group, PaginatedResponse } from '@/types/api'
import { formatBytes, formatDate } from '@/lib/utils'

export const Route = createFileRoute('/_auth/admin/users/')({
  component: AdminUsersPage,
})

// ─── Preset quota options ─────────────────────────────────────────────────────
const QUOTA_OPTIONS = [
  { label: '10 GB',  bytes: 10_737_418_240 },
  { label: '50 GB',  bytes: 53_687_091_200 },
  { label: '100 GB', bytes: 107_374_182_400 },
  { label: '500 GB', bytes: 536_870_912_000 },
  { label: '1 TB',   bytes: 1_099_511_627_776 },
]

// ─── New User Dialog ──────────────────────────────────────────────────────────
interface NewUserDialogProps {
  groups: Group[]
  onClose: () => void
  onCreated: () => void
}

function NewUserDialog({ groups, onClose, onCreated }: NewUserDialogProps) {
  const [email, setEmail]               = useState('')
  const [displayName, setDisplayName]   = useState('')
  const [password, setPassword]         = useState('')
  const [role, setRole]                 = useState<'user' | 'admin'>('user')
  const [quotaBytes, setQuotaBytes]     = useState(QUOTA_OPTIONS[0].bytes)
  const [selectedGroups, setSelectedGroups] = useState<string[]>([])
  const [showPw, setShowPw]             = useState(false)
  const [error, setError]               = useState('')

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/api/v1/admin/users', {
      email,
      display_name: displayName,
      password,
      role,
      quota_bytes: quotaBytes,
      group_ids: selectedGroups,
    }),
    onSuccess: () => { toast.success('User created'); onCreated(); onClose() },
    onError: (e: Error) => setError(e.message),
  })

  const toggleGroup = (id: string) =>
    setSelectedGroups(prev => prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-[#2d3148]">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100">New user</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-200 transition-colors">
            <X size={18} />
          </button>
        </div>

        <form
          className="px-6 py-5 space-y-4"
          onSubmit={e => { e.preventDefault(); setError(''); create.mutate(undefined) }}
        >
          <Field label="Email address (login name)">
            <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
              placeholder="user@example.com" className={inputCls} />
          </Field>

          <Field label="Full name">
            <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
              placeholder="Defaults to email if left empty" className={inputCls} />
          </Field>

          <Field label="Password">
            <div className="relative">
              <input type={showPw ? 'text' : 'password'} required minLength={8}
                value={password} onChange={e => setPassword(e.target.value)}
                placeholder="Min. 8 characters" className={inputCls + ' pr-14'} />
              <button type="button" onClick={() => setShowPw(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300">
                {showPw ? 'Hide' : 'Show'}
              </button>
            </div>
          </Field>

          <Field label="Role">
            <div className="flex gap-4">
              {(['user', 'admin'] as const).map(r => (
                <label key={r} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="role" value={r} checked={role === r}
                    onChange={() => setRole(r)} className="accent-brand-600" />
                  <span className="text-sm text-zinc-700 dark:text-slate-300 capitalize">{r}</span>
                </label>
              ))}
            </div>
          </Field>

          <Field label="Quota">
            <select value={quotaBytes} onChange={e => setQuotaBytes(Number(e.target.value))} className={inputCls}>
              {QUOTA_OPTIONS.map(q => (
                <option key={q.bytes} value={q.bytes}>{q.label}</option>
              ))}
            </select>
          </Field>

          {groups.length > 0 && (
            <Field label="Groups">
              <div className="flex flex-wrap gap-2">
                {groups.map(g => {
                  const active = selectedGroups.includes(g.id)
                  return (
                    <button key={g.id} type="button" onClick={() => toggleGroup(g.id)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
                        active ? 'border-transparent text-white' : 'border-zinc-200 dark:border-[#2d3148] text-zinc-600 dark:text-slate-400 hover:bg-zinc-50 dark:hover:bg-[#2d3148]'
                      }`}
                      style={active ? { backgroundColor: g.color } : {}}
                    >
                      <span className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: active ? 'rgba(255,255,255,0.65)' : g.color }} />
                      {g.name}
                    </button>
                  )
                })}
              </div>
            </Field>
          )}

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-zinc-600 dark:text-slate-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={create.isPending}
              className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
              {create.isPending ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

const inputCls =
  'w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-zinc-500 dark:text-slate-400 uppercase tracking-wide">{label}</label>
      {children}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
function AdminUsersPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'users' | 'groups'>('users')
  const [showDialog, setShowDialog] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: ({ signal }) => api.get<PaginatedResponse<User>>('/api/v1/admin/users', signal),
  })

  const { data: groups = [] } = useQuery({
    queryKey: ['admin', 'groups'],
    queryFn: ({ signal }) => api.get<Group[]>('/api/v1/admin/groups', signal),
  })

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 bg-zinc-100 dark:bg-[#0f1117] rounded-lg p-1">
          {(['users', 'groups'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors capitalize ${
                tab === t
                  ? 'bg-white dark:bg-[#1a1d27] text-zinc-900 dark:text-slate-100 shadow-sm'
                  : 'text-zinc-500 dark:text-slate-400 hover:text-zinc-700 dark:hover:text-slate-200'
              }`}>{t}</button>
          ))}
        </div>
        {tab === 'users' && (
          <button onClick={() => setShowDialog(true)}
            className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors">
            New user
          </button>
        )}
      </div>

      {/* Users tab */}
      {tab === 'users' && (
        <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center h-40 text-sm text-muted">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">User</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">Role</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">Quota</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">Last login</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
                {(data?.items ?? []).map(user => (
                  <UserRow key={user.id} user={user} />
                ))}
                {(data?.items?.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-muted">No users found</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Groups tab */}
      {tab === 'groups' && <GroupsPanel groups={groups} qc={qc} />}

      {showDialog && (
        <NewUserDialog
          groups={groups}
          onClose={() => setShowDialog(false)}
          onCreated={() => void qc.invalidateQueries({ queryKey: ['admin', 'users'] })}
        />
      )}
    </div>
  )
}

// ─── Groups panel (embedded in users page) ───────────────────────────────────
const COLORS = [
  '#6b7280', '#ef4444', '#f97316', '#eab308',
  '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
]

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {COLORS.map(c => (
        <button key={c} type="button" onClick={() => onChange(c)}
          className={`w-5 h-5 rounded-full transition-transform ${value === c ? 'ring-2 ring-offset-2 ring-zinc-400 dark:ring-slate-500 scale-110' : 'hover:scale-110'}`}
          style={{ backgroundColor: c }} />
      ))}
    </div>
  )
}

function GroupsPanel({ groups, qc }: { groups: Group[]; qc: ReturnType<typeof useQueryClient> }) {
  const [name, setName]         = useState('')
  const [color, setColor]       = useState(COLORS[0])
  const [editId, setEditId]     = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')

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
    <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
      {/* Create form */}
      <form
        onSubmit={e => { e.preventDefault(); create.mutate(undefined) }}
        className="px-4 py-3 border-b border-zinc-100 dark:border-[#2d3148] flex gap-3 flex-wrap items-end"
      >
        <div className="flex-1 min-w-[150px] space-y-1">
          <label className="text-xs text-muted uppercase tracking-wide font-medium">Group name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="New group…"
            className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted uppercase tracking-wide font-medium">Color</label>
          <ColorPicker value={color} onChange={setColor} />
        </div>
        <button type="submit" disabled={!name.trim() || create.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors shrink-0">
          <Plus size={14} />
          Create
        </button>
      </form>

      {groups.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted">No groups yet</div>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
          {groups.map(g => (
            <li key={g.id} className="flex items-center gap-3 px-4 py-3">
              <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-white text-xs font-bold"
                style={{ backgroundColor: g.color }}>
                {g.name[0]?.toUpperCase()}
              </div>
              {editId === g.id ? (
                <form className="flex gap-2 flex-1 flex-wrap items-center"
                  onSubmit={e => { e.preventDefault(); update.mutate(undefined) }}>
                  <input autoFocus value={editName} onChange={e => setEditName(e.target.value)}
                    className="flex-1 min-w-[120px] rounded-lg border border-brand-400 bg-zinc-50 dark:bg-[#0f1117] px-3 py-1 text-sm text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500" />
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
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300 hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors" title="Edit">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => { if (confirm(`Delete group "${g.name}"?`)) remove.mutate(g.id) }}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" title="Delete">
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
  )
}

function UserRow({ user }: { user: User }) {
  const percent = user.quota_bytes > 0
    ? Math.min(100, (user.quota_used_bytes / user.quota_bytes) * 100)
    : 0

  return (
    <tr className="hover:bg-zinc-50 dark:hover:bg-[#0f1117] transition-colors">
      <td className="px-4 py-3">
        <div>
          <p className="font-medium text-zinc-900 dark:text-slate-100">{user.display_name}</p>
          <p className="text-xs text-muted">{user.email}</p>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
          user.role === 'admin'
            ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'
            : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
        }`}>
          {user.role}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="space-y-1 min-w-[120px]">
          <div className="flex justify-between text-xs text-muted">
            <span>{formatBytes(user.quota_used_bytes)}</span>
            <span>{formatBytes(user.quota_bytes)}</span>
          </div>
          <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                percent > 90 ? 'bg-red-500' : percent > 70 ? 'bg-amber-500' : 'bg-brand-500'
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-xs text-muted">
        {user.last_login_at ? formatDate(user.last_login_at) : '—'}
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center gap-1 text-xs ${
          user.is_active ? 'text-green-600 dark:text-green-400' : 'text-zinc-400'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${user.is_active ? 'bg-green-500' : 'bg-zinc-400'}`} />
          {user.is_active ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <a
          href={`/admin/users/${user.id}`}
          className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
        >
          Edit
        </a>
      </td>
    </tr>
  )
}
