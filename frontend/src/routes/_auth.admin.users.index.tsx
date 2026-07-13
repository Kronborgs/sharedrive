import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useRef, useEffect } from 'react'
import { toast } from 'sonner'
import { X, Plus, Pencil, Trash2, UserCheck, Folder, File, ChevronDown, ChevronRight, Lock, LockOpen, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react'
import { api, adminRevokeTOTP, adminRequireTOTP, adminUnrequireTOTP } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import type { User, Group, PaginatedResponse, GuestUser } from '@/types/api'
import { formatBytes, formatDate } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

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

function NewUserDialog({ groups, defaultQuotaBytes, onClose, onCreated }: Readonly<NewUserDialogProps>) {
  // Pre-select the default quota; fall back to first preset if 0
  const initial = defaultQuotaBytes > 0 ? defaultQuotaBytes : QUOTA_OPTIONS[0].bytes
  const isPreset = QUOTA_OPTIONS.some(q => q.bytes === initial)
  const { t } = useI18n()

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
    onSuccess: () => { toast.success(t('users.created')); onCreated(); onClose() },
    onError: (e: Error) => setError(e.message),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-[#2d3148]">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100">{t('users.newUser')}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-200 transition-colors">
            <X size={18} />
          </button>
        </div>

        <form
          className="px-6 py-5 space-y-4"
          onSubmit={e => { e.preventDefault(); setError(''); create.mutate(undefined) }}
        >
          <Field label={t('users.emailField')}>
            <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
              placeholder="user@example.com" className={inputCls} />
          </Field>

          <Field label={t('users.fullName')}>
            <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
              placeholder={t('users.fullNamePlaceholder')} className={inputCls} />
          </Field>

          <Field label={t('login.password')}>
            <div className="relative">
              <input type={showPw ? 'text' : 'password'} required minLength={8}
                value={password} onChange={e => setPassword(e.target.value)}
                placeholder={t('users.passwordMinChars')} className={inputCls + ' pr-14'} />
              <button type="button" onClick={() => setShowPw(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300">
                {showPw ? t('users.hide') : t('users.show')}
              </button>
            </div>
          </Field>

          <Field label={t('users.role')}>
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

          <Field label={t('users.quota')}>
            <select value={quotaSelect} onChange={e => setQuotaSelect(Number(e.target.value))} className={inputCls}>
              {QUOTA_OPTIONS.map(q => (
                <option key={q.bytes} value={q.bytes}>{q.label}</option>
              ))}
              <option value={CUSTOM_SENTINEL}>{t('users.custom')}</option>
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

          <Field label={t('users.groups')}>
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
              {t('users.cancel')}
            </button>
            <button type="submit" disabled={create.isPending}
              className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
              {create.isPending ? t('users.creatingUser') : t('users.createUser')}
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

function GroupCombobox({ allGroups, selected, onChange }: Readonly<GroupComboboxProps>) {
  const qc = useQueryClient()
  const [input, setInput]   = useState('')
  const [open, setOpen]     = useState(false)
  const [busy, setBusy]     = useState(false)
  const ref                 = useRef<HTMLDivElement>(null)
  const { t } = useI18n()

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
          placeholder={t('users.searchOrCreateGroup')}
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
                {busy ? t('users.creatingGroup') : t('users.createGroupNamed', { name: trimmed })}
              </button>
            )}
            {filtered.length === 0 && !canCreate && (
              <div className="px-3 py-2 text-xs text-muted">{t('users.noGroupsFound')}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const inputCls =
  'w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500'

function Field({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
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
  const { user: me } = useAuth()
  const [tab, setTab] = useState<'users' | 'guests' | 'groups'>('users')
  const [showDialog, setShowDialog] = useState(false)
  const [editUser, setEditUser] = useState<User | null>(null)
  const { t } = useI18n()

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

  const invalidateUsers = () => void qc.invalidateQueries({ queryKey: ['admin', 'users'] })

  const lockMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/admin/users/${id}/lock`),
    onSuccess: () => { toast.success(t('users.locked')); invalidateUsers() },
    onError: () => toast.error(t('users.lockFailed')),
  })

  const unlockMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/admin/users/${id}/unlock`),
    onSuccess: () => { toast.success(t('users.unlocked')); invalidateUsers() },
    onError: () => toast.error(t('users.unlockFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/users/${id}`),
    onSuccess: () => { toast.success(t('users.deleted')); invalidateUsers() },
    onError: () => toast.error(t('users.deleteFailed')),
  })

  const forceResetMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/admin/users/${id}/force-password-reset`),
    onSuccess: () => toast.success(t('users.passwordResetForced')),
    onError: () => toast.error(t('users.passwordResetFailed')),
  })

  const changeRoleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: 'user' | 'admin' }) =>
      api.patch(`/api/v1/admin/users/${id}`, { role }),
    onSuccess: (_data, { role }) => {
      toast.success(role === 'admin' ? t('users.promoted') : t('users.demoted'))
      invalidateUsers()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const adminCount = (data?.items ?? []).filter(u => u.role === 'admin').length

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
            {t('users.newUser')}
          </button>
        )}
      </div>

      {/* Users tab */}
      {tab === 'users' && (
        <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center h-40 text-sm text-muted">{t('users.loading')}</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">{t('users.colUser')}</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">{t('users.role')}</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">{t('users.quota')}</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">{t('users.lastLogin')}</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">{t('users.status')}</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">{t('users.twofa')}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
                {(data?.items ?? []).map(user => (
                  <UserRow
                    key={user.id}
                    user={user}
                    isSelf={user.id === me?.id}
                    isLastAdmin={adminCount <= 1 && user.role === 'admin'}
                    onEdit={setEditUser}
                    onLock={id => lockMutation.mutate(id)}
                    onUnlock={id => unlockMutation.mutate(id)}
                    onChangeRole={role => changeRoleMutation.mutate({ id: user.id, role })}
                    onRevokeTOTP={async id => {
                      if (confirm(t('users.confirmRevokeTOTP'))) {
                        try {
                          await adminRevokeTOTP(id)
                          toast.success(t('users.totpRevoked'))
                          void qc.invalidateQueries({ queryKey: ['admin', 'users'] })
                        } catch {
                          toast.error(t('users.totpRevokeFailed'))
                        }
                      }
                    }}
                    onRequireTOTP={async id => {
                      try {
                        await adminRequireTOTP(id)
                        toast.success(t('users.totpRequired'))
                        void qc.invalidateQueries({ queryKey: ['admin', 'users'] })
                      } catch {
                        toast.error(t('users.totpRequireFailed'))
                      }
                    }}
                    onUnrequireTOTP={async id => {
                      try {
                        await adminUnrequireTOTP(id)
                        toast.success(t('users.totpRequirementRemoved'))
                        void qc.invalidateQueries({ queryKey: ['admin', 'users'] })
                      } catch {
                        toast.error(t('users.totpRequirementRemoveFailed'))
                      }
                    }}
                    onDelete={id => {
                      if (confirm(t('users.confirmDelete', { name: data?.items?.find(u => u.id === id)?.display_name ?? id }))) {
                        deleteMutation.mutate(id)
                      }
                    }}
                    onForceReset={id => {
                      if (confirm(t('users.confirmForceReset'))) {
                        forceResetMutation.mutate(id)
                      }
                    }}
                  />
                ))}
                {(data?.items?.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center py-8 text-muted">{t('users.noUsersFound')}</td>
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

function ColorPicker({ value, onChange }: Readonly<{ value: string; onChange: (c: string) => void }>) {
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
}: Readonly<{
  guests: GuestUser[]
  isLoading: boolean
  qc: ReturnType<typeof useQueryClient>
}>) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const { t } = useI18n()

  const promote = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/admin/guests/${id}/promote`, {}),
    onSuccess: () => {
      toast.success(t('users.guestPromoted'))
      void qc.invalidateQueries({ queryKey: ['admin', 'guests'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] })
    },
    onError: () => toast.error(t('users.guestPromoteFailed')),
  })

  const deactivate = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/guests/${id}`),
    onSuccess: () => {
      toast.success(t('users.guestRemoved'))
      void qc.invalidateQueries({ queryKey: ['admin', 'guests'] })
    },
    onError: () => toast.error(t('users.guestRemoveFailed')),
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
        <div className="flex items-center justify-center h-40 text-sm text-muted">{t('users.loading')}</div>
      ) : guests.length === 0 ? (
        <div className="flex items-center justify-center h-40 text-sm text-muted">{t('users.noGuests')}</div>
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
                      {t('users.invitedBy')} {guest.invited_by_name ?? '—'} · {formatDate(guest.created_at)}
                      {guest.last_login_at
                        ? ` · ${t('users.lastLoginAt')} ${formatDate(guest.last_login_at)}`
                        : ` · ${t('users.neverLoggedIn')}`
                      }
                    </p>
                  </div>

                  {/* Shared count badge */}
                  <div className="text-xs text-muted shrink-0">
                    {guest.shared_items.length} {t('users.sharedItemLabel')}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => {
                        if (confirm(t('users.confirmPromoteGuest', { name: guest.display_name || guest.email }))) {
                          promote.mutate(guest.id)
                        }
                      }}
                      disabled={promote.isPending}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-xs font-medium transition-colors"
                      title={t('users.promoteToUser')}
                    >
                      <UserCheck size={13} />
                      {t('users.promote')}
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(t('users.confirmRemoveGuest', { email: guest.email }))) {
                          deactivate.mutate(guest.id)
                        }
                      }}
                      disabled={deactivate.isPending}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                      title={t('users.removeGuest')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Expandable shared items list */}
                {isExpanded && (
                  <div className="px-12 pb-3 space-y-1">
                    {guest.shared_items.length === 0 ? (
                      <p className="text-xs text-muted py-1">{t('users.nothingShared')}</p>
                    ) : (
                      guest.shared_items.map(item => (
                        <div key={item.resource_id} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-slate-400">
                          {item.is_folder
                            ? <Folder size={13} className="text-amber-500 shrink-0" />
                            : <File size={13} className="text-zinc-400 shrink-0" />
                          }
                          <span className="font-medium text-zinc-800 dark:text-slate-200 truncate">{item.name}</span>
                          <span className="text-zinc-400 shrink-0">{t('users.sharedBy')} {item.owner_email}</span>
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

function GroupsPanel({ groups, qc }: Readonly<{ groups: Group[]; qc: ReturnType<typeof useQueryClient> }>) {
  const [name, setName]         = useState('')
  const [color, setColor]       = useState(COLORS[0])
  const [editId, setEditId]     = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('')
  const { t } = useI18n()

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
          <label className="text-xs text-muted uppercase tracking-wide font-medium">{t('users.groupName')}</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={t('users.newGroupPlaceholder')}
            className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted uppercase tracking-wide font-medium">{t('users.color')}</label>
          <ColorPicker value={color} onChange={setColor} />
        </div>
        <button type="submit" disabled={!name.trim() || create.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors shrink-0">
          <Plus size={14} />
          {t('users.create')}
        </button>
      </form>

      {groups.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted">{t('users.noGroups')}</div>
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
                    {t('users.save')}
                  </button>
                  <button type="button" onClick={() => setEditId(null)}
                    className="px-3 py-1 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-muted hover:bg-zinc-50 dark:hover:bg-[#2d3148]">
                    {t('users.cancel')}
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
                    <button onClick={() => { if (confirm(t('users.confirmDeleteGroup', { name: g.name }))) remove.mutate(g.id) }}
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

function UserRow({
  user,
  onEdit,
  onLock,
  onUnlock,
  onDelete,
  onForceReset,
  onRevokeTOTP,
  onRequireTOTP,
  onUnrequireTOTP,
  onChangeRole,
  isSelf,
  isLastAdmin,
}: Readonly<{
  user: User
  onEdit: (u: User) => void
  onLock: (id: string) => void
  onUnlock: (id: string) => void
  onDelete: (id: string) => void
  onForceReset: (id: string) => void
  onRevokeTOTP: (id: string) => void
  onRequireTOTP: (id: string) => void
  onUnrequireTOTP: (id: string) => void
  onChangeRole: (role: 'user' | 'admin') => void
  isSelf: boolean
  isLastAdmin: boolean
}>) {
  const percent = user.quota_bytes > 0
    ? Math.min(100, (user.quota_used_bytes / user.quota_bytes) * 100)
    : 0
  const { t } = useI18n()

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
          user.is_active ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${user.is_active ? 'bg-green-500' : 'bg-red-500'}`} />
          {user.is_active ? t('users.active') : t('users.lockedStatus')}
        </span>
      </td>
      <td className="px-4 py-3">
        {user.totp_enabled ? (
          <button
            onClick={() => onRevokeTOTP(user.id)}
            title={t('users.totpActiveRevoke')}
            className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
          >
            <ShieldCheck size={13} />
            {t('users.enabled')}
          </button>
        ) : user.force_totp_setup ? (
          <div className="inline-flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              <ShieldCheck size={13} />
              {t('users.required')}
            </span>
            <button
              onClick={() => onUnrequireTOTP(user.id)}
              title={t('users.cancelTotpReq')}
              className="text-xs text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition-colors leading-none"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="inline-flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
              <ShieldOff size={13} />
              {t('users.off')}
            </span>
            <button
              onClick={() => onRequireTOTP(user.id)}
              title={t('users.forceTotpSetup')}
              className="text-xs text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors underline underline-offset-2"
            >
              {t('users.force')}
            </button>
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={() => onEdit(user)}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300 hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors"
            title={t('users.editQuota')}
          >
            <Pencil size={14} />
          </button>
          {user.role === 'admin' ? (
            <button
              onClick={() => {
                if (confirm(t('users.confirmDemote', { name: user.display_name })))
                  onChangeRole('user')
              }}
              disabled={isLastAdmin || isSelf}
              className="p-1.5 rounded-lg text-purple-500 hover:text-zinc-500 dark:hover:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={isLastAdmin ? t('users.cannotDemoteLastAdmin') : isSelf ? t('users.cannotDemoteSelf') : t('users.demoteToUser')}
            >
              <ShieldCheck size={14} />
            </button>
          ) : (
            <button
              onClick={() => {
                if (confirm(t('users.confirmPromote', { name: user.display_name })))
                  onChangeRole('admin')
              }}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors"
              title={t('users.promoteToAdmin')}
            >
              <ShieldOff size={14} />
            </button>
          )}
          {user.is_active ? (
            <button
              onClick={() => onLock(user.id)}
              disabled={isSelf}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={isSelf ? t('users.cannotLockSelf') : t('users.lockAccount')}
            >
              <LockOpen size={14} />
            </button>
          ) : (
            <button
              onClick={() => onUnlock(user.id)}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-green-600 dark:hover:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
              title={t('users.unlockAccount')}
            >
              <Lock size={14} />
            </button>
          )}
          <button
            onClick={() => onForceReset(user.id)}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/20 transition-colors"
            title="Force password reset on next login"
          >
            <KeyRound size={14} />
          </button>
          <button
            onClick={() => onDelete(user.id)}
            disabled={isSelf}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={isSelf ? 'Cannot delete your own account' : 'Delete user'}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </td>
    </tr>
  )
}

// ─── Edit User Dialog ─────────────────────────────────────────────────────────
// ─── Quota input helpers ──────────────────────────────────────────────────────

/** Parse a human-readable size string like "1GB", "500 MB", "2.5TB" → bytes, or null on failure. */
function parseQuotaInput(s: string): number | null {
  const m = s.trim().match(/^([0-9]*\.?[0-9]+)\s*(KB|MB|GB|TB|PB|B)?$/i)
  if (!m) return null
  const n = Number.parseFloat(m[1])
  const unit = (m[2] ?? 'B').toUpperCase()
  const multipliers: Record<string, number> = {
    B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5,
  }
  return Math.round(n * (multipliers[unit] ?? 1))
}

/** Format bytes back to a short readable string for the input placeholder. */
function formatQuotaForInput(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  const rounded = Number.parseFloat(v.toFixed(2))
  return `${rounded} ${units[i]}`
}

function EditUserDialog({ user, onClose, onSaved }: Readonly<{ user: User; onClose: () => void; onSaved: () => void }>) {
  const [quotaInput, setQuotaInput]     = useState(() => formatQuotaForInput(user.quota_bytes))
  const [uploadInput, setUploadInput]   = useState(() => user.max_upload_bytes != null ? formatQuotaForInput(user.max_upload_bytes) : '')
  const [trashDays, setTrashDays]       = useState<string>(user.trash_retention_days != null ? String(user.trash_retention_days) : '')
  const { t } = useI18n()

  const { data: stats } = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: ({ signal }) => api.get<{ disk_free_bytes: number }>('/api/v1/admin/stats', signal),
    staleTime: 60_000,
  })

  // Max quota = free disk * 75%  (25% headroom)
  const maxQuotaBytes = stats ? Math.floor(stats.disk_free_bytes * 0.75) : null

  const parsedBytes  = parseQuotaInput(quotaInput)
  const isValid      = parsedBytes !== null && parsedBytes > 0
  const overLimit    = maxQuotaBytes !== null && isValid && parsedBytes > maxQuotaBytes
  const quotaBytes   = isValid ? parsedBytes : user.quota_bytes

  const parsedUpload  = uploadInput.trim() === '' ? null : parseQuotaInput(uploadInput)
  const uploadIsValid = uploadInput.trim() === '' || (parsedUpload !== null && parsedUpload > 0)
  const uploadBytes   = parsedUpload

  const save = useMutation({
    mutationFn: () => api.patch(`/api/v1/admin/users/${user.id}`, {
      quota_bytes: quotaBytes,
      max_upload_bytes: uploadBytes,
      trash_retention_days: trashDays !== '' ? Number.parseInt(trashDays, 10) : null,
    }),
    onSuccess: () => { onSaved(); onClose() },
    onError: () => toast.error(t('users.saveFailed')),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl shadow-xl w-full max-w-sm mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100">{t('users.editUser', { name: user.display_name })}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600"><X size={16} /></button>
        </div>

        <div className="space-y-4">
          <Field label={t('users.quota')}>
            <input
              type="text"
              value={quotaInput}
              onChange={e => setQuotaInput(e.target.value)}
              placeholder={t('users.quotaPlaceholder')}
              className={`w-full px-3 py-2 rounded-lg border text-sm text-zinc-900 dark:text-slate-100 bg-white dark:bg-[#0f1117] ${
                !isValid
                  ? 'border-red-400 dark:border-red-500'
                  : overLimit
                  ? 'border-amber-400 dark:border-amber-500'
                  : 'border-zinc-300 dark:border-[#2d3148]'
              }`}
            />
            <div className="mt-1 space-y-0.5">
              {isValid && (
                <p className="text-xs text-muted">{formatBytes(parsedBytes!)} ({parsedBytes!.toLocaleString()} bytes)</p>
              )}
              {!isValid && quotaInput.trim() !== '' && (
                <p className="text-xs text-red-500">{t('users.quotaInvalidFormat')}</p>
              )}
              {overLimit && maxQuotaBytes !== null && (
                <p className="text-xs text-amber-500">
                  {t('users.quotaExceedsHeadroom', { max: formatBytes(maxQuotaBytes), free: formatBytes(stats!.disk_free_bytes) })}
                </p>
              )}
              {!overLimit && maxQuotaBytes !== null && (
                <p className="text-xs text-muted">{t('users.quotaMax', { max: formatBytes(maxQuotaBytes) })}</p>
              )}
            </div>
          </Field>

          <Field label={t('users.maxUploadSize')}>
            <input
              type="text"
              value={uploadInput}
              onChange={e => setUploadInput(e.target.value)}
              placeholder={t('users.maxUploadPlaceholder')}
              className={`w-full px-3 py-2 rounded-lg border text-sm text-zinc-900 dark:text-slate-100 bg-white dark:bg-[#0f1117] ${
                !uploadIsValid
                  ? 'border-red-400 dark:border-red-500'
                  : 'border-zinc-300 dark:border-[#2d3148]'
              }`}
            />
            <div className="mt-1 space-y-0.5">
              {uploadIsValid && parsedUpload !== null && (
                <p className="text-xs text-muted">{formatQuotaForInput(parsedUpload)} ({parsedUpload.toLocaleString()} bytes)</p>
              )}
              {!uploadIsValid && uploadInput.trim() !== '' && (
                <p className="text-xs text-red-500">{t('users.quotaInvalidFormat')}</p>
              )}
              {uploadIsValid && uploadInput.trim() === '' && (
                <p className="text-xs text-muted">{t('users.usesSystemDefault')}</p>
              )}
            </div>
          </Field>

          <Field label={t('users.trashRetention')}>
            <input
              type="number"
              min={1}
              max={365}
              placeholder="30"
              value={trashDays}
              onChange={e => setTrashDays(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-[#2d3148] bg-white dark:bg-[#0f1117] text-sm text-zinc-900 dark:text-slate-100"
            />
            <p className="text-xs text-muted mt-1">{t('users.trashRetentionDesc')}</p>
          </Field>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148]">{t('users.cancel')}</button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !isValid || overLimit || !uploadIsValid}
            className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium disabled:opacity-50"
          >
            {save.isPending ? t('settings.saving') : t('users.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
