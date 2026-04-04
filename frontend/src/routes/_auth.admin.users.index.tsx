import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useRef, useEffect } from 'react'
import { toast } from 'sonner'
import { X, Plus, Pencil, Trash2, UserCheck, Folder, File, ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import type { User, Group, PaginatedResponse, GuestUser } from '@/types/api'
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
const CUSTOM_SENTINEL = -1

interface NewUserDialogProps {
  groups: Group[]
  defaultQuotaBytes: number
  onClose: () => void
  onCreated: () => void
}

function NewUserDialog({ groups, defaultQuotaBytes, onClose, onCreated }: NewUserDialogProps) {
  // Pre-select the default quota; fall back to first preset if 0
  const initial = defaultQuotaBytes > 0 ? defaultQuotaBytes : QUOTA_OPTIONS[0].bytes
  const isPreset = QUOTA_OPTIONS.some(q => q.bytes === initial)

  const [email, setEmail]               = useState('')
  const [displayName, setDisplayName]   = useState('')
  const [password, setPassword]         = useState('')
  const [role, setRole]                 = useState<'user' | 'admin'>('user')
  const [quotaSelect, setQuotaSelect]   = useState(isPreset ? initial : CUSTOM_SENTINEL)
  const [customGB, setCustomGB]         = useState(isPreset ? 10 : Math.round(initial / 1_073_741_824))
  const [selectedGroups, setSelectedGroups] = useState<string[]>([])
  const [showPw, setShowPw]             = useState(false)
  const [error, setError]               = useState('')

  const quotaBytes = quotaSelect === CUSTOM_SENTINEL
    ? Math.round(customGB * 1_073_741_824)
    : quotaSelect

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
            <select value={quotaSelect} onChange={e => setQuotaSelect(Number(e.target.value))} className={inputCls}>
              {QUOTA_OPTIONS.map(q => (
                <option key={q.bytes} value={q.bytes}>{q.label}</option>
              ))}
              <option value={CUSTOM_SENTINEL}>Custom…</option>
            </select>
            {quotaSelect === CUSTOM_SENTINEL && (
              <div className="flex items-center gap-2 mt-1.5">
                <input type="number" min="1" step="1" value={customGB}
                  onChange={e => setCustomGB(Number(e.target.value))}
                  className={inputCls + ' w-28'} />
                <span className="text-sm text-muted">GB</span>
              </div>
            )}
          </Field>

          <Field label="Groups">
            <GroupCombobox
              allGroups={groups}
              selected={selectedGroups}
              onChange={setSelectedGroups}
            />
          </Field>

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

// ─── Group combobox: search existing + create new inline ─────────────────────
interface GroupComboboxProps {
  allGroups: Group[]
  selected: string[]
  onChange: (ids: string[]) => void
}

function GroupCombobox({ allGroups, selected, onChange }: GroupComboboxProps) {
  const qc = useQueryClient()
  const [input, setInput]   = useState('')
  const [open, setOpen]     = useState(false)
  const [busy, setBusy]     = useState(false)
  const ref                 = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const trimmed    = input.trim()
  const filtered   = allGroups.filter(g =>
    g.name.toLowerCase().includes(trimmed.toLowerCase()) && !selected.includes(g.id)
  )
  const exactMatch = allGroups.some(g => g.name.toLowerCase() === trimmed.toLowerCase())
  const canCreate  = trimmed.length > 0 && !exactMatch

  const selectedGroups = allGroups.filter(g => selected.includes(g.id))

  const addGroup = (id: string) => {
    onChange([...selected, id])
    setInput('')
    setOpen(false)
  }

  const removeGroup = (id: string) => onChange(selected.filter(s => s !== id))

  const createAndAdd = async () => {
    if (!trimmed || busy) return
    setBusy(true)
    try {
      const res = await api.post<{ id: string }>('/api/v1/admin/groups', {
        name: trimmed,
        color: '#6b7280',
      })
      void qc.invalidateQueries({ queryKey: ['admin', 'groups'] })
      onChange([...selected, res.id])
      setInput('')
      setOpen(false)
    } catch {
      // ignore — group panel can handle errors later
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={ref} className="space-y-1.5">
      {/* Selected badges */}
      {selectedGroups.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedGroups.map(g => (
            <span key={g.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white"
              style={{ backgroundColor: g.color }}
            >
              {g.name}
              <button type="button" onClick={() => removeGroup(g.id)}
                className="ml-0.5 opacity-70 hover:opacity-100 transition-opacity">
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="relative">
        <input
          type="text"
          value={input}
          onChange={e => { setInput(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder="Search or create a group…"
          className={inputCls}
        />

        {/* Dropdown */}
        {open && (trimmed.length > 0 || filtered.length > 0) && (
          <div className="absolute z-50 left-0 right-0 top-full mt-1 bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-lg shadow-lg overflow-hidden max-h-48 overflow-y-auto">
            {filtered.map(g => (
              <button key={g.id} type="button" onMouseDown={() => addGroup(g.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors">
                <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: g.color }} />
                <span className="text-zinc-900 dark:text-slate-100">{g.name}</span>
              </button>
            ))}
            {canCreate && (
              <button type="button" onMouseDown={createAndAdd} disabled={busy}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-brand-600 dark:text-brand-400 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-50">
                <Plus size={13} className="shrink-0" />
                {busy ? 'Creating…' : `Create group "${trimmed}"`}
              </button>
            )}
            {filtered.length === 0 && !canCreate && (
              <div className="px-3 py-2 text-xs text-muted">No groups found</div>
            )}
          </div>
        )}
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
  const [tab, setTab] = useState<'users' | 'guests' | 'groups'>('users')
  const [showDialog, setShowDialog] = useState(false)
  const [editUser, setEditUser] = useState<User | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: ({ signal }) => api.get<PaginatedResponse<User>>('/api/v1/admin/users', signal),
  })

  const { data: guests = [], isLoading: guestsLoading } = useQuery({
    queryKey: ['admin', 'guests'],
    queryFn: ({ signal }) => api.get<GuestUser[]>('/api/v1/admin/guests', signal),
    enabled: tab === 'guests',
  })

  const { data: groups = [] } = useQuery({
    queryKey: ['admin', 'groups'],
    queryFn: ({ signal }) => api.get<Group[]>('/api/v1/admin/groups', signal),
  })

  const { data: settings } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: ({ signal }) => api.get<{ default_quota_bytes: number }>('/api/v1/admin/settings', signal),
  })

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 bg-zinc-100 dark:bg-[#0f1117] rounded-lg p-1">
          {(['users', 'guests', 'groups'] as const).map(t => (
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
                  <UserRow key={user.id} user={user} onEdit={setEditUser} />
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

      {/* Guests tab */}
      {tab === 'guests' && (
        <GuestsPanel guests={guests} isLoading={guestsLoading} qc={qc} />
      )}

      {/* Groups tab */}
      {tab === 'groups' && <GroupsPanel groups={groups} qc={qc} />}

      {showDialog && (
        <NewUserDialog
          groups={groups}
          defaultQuotaBytes={settings?.default_quota_bytes ?? 0}
          onClose={() => setShowDialog(false)}
          onCreated={() => void qc.invalidateQueries({ queryKey: ['admin', 'users'] })}
        />
      )}

      {editUser && (
        <EditUserDialog
          user={editUser}
          onClose={() => setEditUser(null)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ['admin', 'users'] })}
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

// ─── Guests panel ─────────────────────────────────────────────────────────────
function GuestsPanel({
  guests,
  isLoading,
  qc,
}: {
  guests: GuestUser[]
  isLoading: boolean
  qc: ReturnType<typeof useQueryClient>
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const promote = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/admin/guests/${id}/promote`, {}),
    onSuccess: () => {
      toast.success('Guest promoted to user')
      void qc.invalidateQueries({ queryKey: ['admin', 'guests'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] })
    },
    onError: () => toast.error('Failed to promote guest'),
  })

  const deactivate = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/guests/${id}`),
    onSuccess: () => {
      toast.success('Guest removed')
      void qc.invalidateQueries({ queryKey: ['admin', 'guests'] })
    },
    onError: () => toast.error('Failed to remove guest'),
  })

  const toggle = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  return (
    <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted">Loading…</div>
      ) : guests.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted">No guest users</div>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
          {guests.map(guest => {
            const isExpanded = expanded.has(guest.id)
            return (
              <div key={guest.id}>
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-[#0f1117] transition-colors">
                  {/* Expand toggle */}
                  <button
                    onClick={() => toggle(guest.id)}
                    className="text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300 shrink-0"
                    title="Toggle shared items"
                  >
                    {isExpanded
                      ? <ChevronDown size={15} />
                      : <ChevronRight size={15} />
                    }
                  </button>

                  {/* Avatar */}
                  <div className="w-8 h-8 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center shrink-0">
                    <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                      {(guest.display_name || guest.email)[0]?.toUpperCase()}
                    </span>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-zinc-900 dark:text-slate-100 truncate">
                        {guest.display_name || guest.email}
                      </p>
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 shrink-0">
                        guest
                      </span>
                    </div>
                    <p className="text-xs text-muted truncate">{guest.email}</p>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      Invited by {guest.invited_by_name ?? '—'} · {formatDate(guest.created_at)}
                      {guest.last_login_at
                        ? ` · Last login ${formatDate(guest.last_login_at)}`
                        : ' · Never logged in'
                      }
                    </p>
                  </div>

                  {/* Shared count badge */}
                  <div className="text-xs text-muted shrink-0">
                    {guest.shared_items.length} shared item{guest.shared_items.length !== 1 ? 's' : ''}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => {
                        if (confirm(`Promote "${guest.display_name || guest.email}" to a regular user? They will get full access to their own file storage.`)) {
                          promote.mutate(guest.id)
                        }
                      }}
                      disabled={promote.isPending}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-xs font-medium transition-colors"
                      title="Promote to regular user"
                    >
                      <UserCheck size={13} />
                      Promote
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Remove guest "${guest.email}"? They will lose access to all shared items.`)) {
                          deactivate.mutate(guest.id)
                        }
                      }}
                      disabled={deactivate.isPending}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                      title="Remove guest"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Expandable shared items list */}
                {isExpanded && (
                  <div className="px-12 pb-3 space-y-1">
                    {guest.shared_items.length === 0 ? (
                      <p className="text-xs text-muted py-1">Nothing shared with this guest yet</p>
                    ) : (
                      guest.shared_items.map(item => (
                        <div key={item.resource_id} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-slate-400">
                          {item.is_folder
                            ? <Folder size={13} className="text-amber-500 shrink-0" />
                            : <File size={13} className="text-zinc-400 shrink-0" />
                          }
                          <span className="font-medium text-zinc-800 dark:text-slate-200 truncate">{item.name}</span>
                          <span className="text-zinc-400 shrink-0">shared by {item.owner_email}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
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

function UserRow({ user, onEdit }: { user: User; onEdit: (u: User) => void }) {
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
        <button
          onClick={() => onEdit(user)}
          className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
        >
          Edit
        </button>
      </td>
    </tr>
  )
}

// ─── Edit User Dialog ─────────────────────────────────────────────────────────
function EditUserDialog({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: () => void }) {
  const [quotaBytes, setQuotaBytes] = useState(user.quota_bytes)
  const [trashDays, setTrashDays] = useState<string>(user.trash_retention_days != null ? String(user.trash_retention_days) : '')

  const save = useMutation({
    mutationFn: () => api.patch(`/api/v1/admin/users/${user.id}`, {
      quota_bytes: quotaBytes,
      trash_retention_days: trashDays !== '' ? parseInt(trashDays, 10) : null,
    }),
    onSuccess: () => { onSaved(); onClose() },
    onError: () => toast.error('Failed to save'),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100">Edit {user.display_name}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600"><X size={16} /></button>
        </div>

        <div className="space-y-4">
          <Field label="Quota (bytes)">
            <input
              type="number"
              min={0}
              value={quotaBytes}
              onChange={e => setQuotaBytes(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-[#2d3148] bg-white dark:bg-[#0f1117] text-sm text-zinc-900 dark:text-slate-100"
            />
            <p className="text-xs text-muted mt-1">{formatBytes(quotaBytes)}</p>
          </Field>

          <Field label="Trash retention (days)">
            <input
              type="number"
              min={1}
              max={365}
              placeholder="30 (default)"
              value={trashDays}
              onChange={e => setTrashDays(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-[#2d3148] bg-white dark:bg-[#0f1117] text-sm text-zinc-900 dark:text-slate-100"
            />
            <p className="text-xs text-muted mt-1">Leave empty to use system default (30 days)</p>
          </Field>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148]">Cancel</button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
