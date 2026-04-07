import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { FileItem, Share, SharePermissions, Group } from '@/types/api'
import { formatDate } from '@/lib/utils'
import { X, Check, Link, Trash2, UserPlus, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'

interface ShareDialogProps {
  item: FileItem
  onClose: () => void
}

type ShareTargetType = 'user' | 'group' | 'link'

const DEFAULT_PERMS: SharePermissions = {
  can_view: true,
  can_upload: false,
  can_edit: false,
  can_delete: false,
  can_reshare: false,
  is_owner: false,
}

// Return tomorrow at noon as a datetime-local string (YYYY-MM-DDTHH:mm)
function defaultExpiry(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(12, 0, 0, 0)
  return d.toISOString().slice(0, 16)
}

const PERM_KEYS = (Object.keys(DEFAULT_PERMS).filter(k => k !== 'is_owner') as (keyof SharePermissions)[])

function PermCheckboxes({
  perms,
  onChange,
  isFolder = true,
}: {
  perms: SharePermissions
  onChange: (p: SharePermissions) => void
  isFolder?: boolean
}) {
  const keys = isFolder ? PERM_KEYS : PERM_KEYS.filter(k => k !== 'can_upload')
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {keys.map(key => (
        <label key={key} className="flex items-center gap-1.5 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={perms[key] as boolean}
            onChange={e => onChange({ ...perms, [key]: e.target.checked })}
            className="rounded border-zinc-300 dark:border-[#4d5678] text-brand-600"
          />
          <span className="text-xs text-zinc-700 dark:text-slate-300 capitalize">
            {key.replace('can_', '')}
          </span>
        </label>
      ))}
    </div>
  )
}

function ActiveShareRow({
  s,
  onRevoke,
  onCopyLink,
  copied,
  onUpdate,
  isFolder = true,
}: {
  s: Share
  onRevoke: () => void
  onCopyLink?: () => void
  copied: boolean
  onUpdate: (perms: SharePermissions, expiresAt: string | null) => void
  isFolder?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [editPerms, setEditPerms] = useState<SharePermissions>({
    can_view: s.can_view,
    can_upload: s.can_upload,
    can_edit: s.can_edit,
    can_delete: s.can_delete,
    can_reshare: s.can_reshare,
    is_owner: false,
  })
  const [editExpiry, setEditExpiry] = useState<string>(
    s.expires_at ? new Date(s.expires_at).toISOString().slice(0, 16) : ''
  )
  const [hasExpiry, setHasExpiry] = useState(!!s.expires_at)

  const displayName =
    s.grantee_type === 'link'
      ? 'Public link'
      : s.grantee_email ?? s.pending_email ?? s.grantee_group_name ?? 'Unknown'

  return (
    <li className="rounded-lg bg-zinc-50 dark:bg-[#0f1117] overflow-hidden">
      {/* Summary row */}
      <div className="flex items-center gap-2 p-2">
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex-1 min-w-0 text-left"
        >
          <p className="text-xs font-medium text-zinc-900 dark:text-slate-100 truncate">{displayName}</p>
          {s.expires_at && (
            <p className="text-[10px] text-muted">Expires {formatDate(s.expires_at)}</p>
          )}
        </button>
        <button
          onClick={() => setExpanded(v => !v)}
          className="p-1 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-slate-300 transition-colors"
          title={expanded ? 'Collapse' : 'Edit permissions'}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {s.grantee_type === 'link' && onCopyLink && (
          <button
            onClick={onCopyLink}
            className="p-1 rounded text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
            title="Copy link"
          >
            {copied ? <Check size={13} /> : <Link size={13} />}
          </button>
        )}
        <button
          onClick={onRevoke}
          className="p-1 rounded text-zinc-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
          title="Revoke"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Expanded edit panel */}
      {expanded && (
        <div className="border-t border-zinc-200 dark:border-[#2d3148] px-3 pb-3 pt-2 space-y-3">
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-zinc-500 dark:text-slate-400">Permissions</p>
            <PermCheckboxes perms={editPerms} onChange={setEditPerms} isFolder={isFolder} />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-medium text-zinc-500 dark:text-slate-400">Expiry</p>
              <button
                type="button"
                onClick={() => setHasExpiry(v => !v)}
                className="text-[11px] text-brand-600 dark:text-brand-400 hover:underline"
              >
                {hasExpiry ? 'Remove expiry' : 'Set expiry'}
              </button>
            </div>
            {hasExpiry ? (
              <input
                type="datetime-local"
                value={editExpiry}
                onChange={e => setEditExpiry(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] px-3 py-1.5 text-xs text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            ) : (
              <p className="text-xs text-muted">Never expires</p>
            )}
          </div>
          <button
            onClick={() => {
              const expiresAt = hasExpiry && editExpiry ? new Date(editExpiry).toISOString() : null
              onUpdate(editPerms, expiresAt)
              setExpanded(false)
            }}
            className="w-full py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium transition-colors"
          >
            Save changes
          </button>
        </div>
      )}
    </li>
  )
}

export function ShareDialog({ item, onClose }: ShareDialogProps) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<ShareTargetType>('user')
  const [email, setEmail] = useState('')
  const [groupId, setGroupId] = useState('')
  const [perms, setPerms] = useState<SharePermissions>(DEFAULT_PERMS)
  const [hasExpiry, setHasExpiry] = useState(false)
  const [expiry, setExpiry] = useState(defaultExpiry())
  const [copied, setCopied] = useState(false)

  const { data: shares } = useQuery({
    queryKey: ['shares', item.id],
    queryFn: ({ signal }) => api.get<Share[]>(`/api/v1/shares?resource_id=${item.id}`, signal),
  })

  const { data: groups } = useQuery({
    queryKey: ['groups'],
    queryFn: ({ signal }) => api.get<Group[]>('/api/v1/groups', signal),
  })

  const createShare = useMutation({
    mutationFn: (body: object) => api.post<Share>(`/api/v1/shares`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shares', item.id] })
      void qc.invalidateQueries({ queryKey: ['files'] })
      setEmail('')
      toast.success('Share created')
    },
    onError: (e: Error) => toast.error(e.message || 'Failed to create share'),
  })

  const revokeShare = useMutation({
    mutationFn: (shareId: string) => api.delete(`/api/v1/shares/${shareId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shares', item.id] })
      void qc.invalidateQueries({ queryKey: ['files'] })
    },
    onError: () => toast.error('Failed to revoke share'),
  })

  const updateShare = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) =>
      api.patch(`/api/v1/shares/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shares', item.id] })
      toast.success('Share updated')
    },
    onError: () => toast.error('Failed to update share'),
  })

  const handleCreate = () => {
    let expiresAt: string | null = null
    if (hasExpiry && expiry) {
      expiresAt = new Date(expiry).toISOString()
    }

    const body: Record<string, unknown> = {
      resource_id: item.id,
      can_view: perms.can_view,
      can_upload: perms.can_upload,
      can_edit: perms.can_edit,
      can_delete: perms.can_delete,
      can_reshare: perms.can_reshare,
      expires_at: expiresAt,
    }

    if (tab === 'user') {
      body.grantee_type = 'user'
      body.grantee_email = email
    } else if (tab === 'group') {
      body.grantee_type = 'group'
      body.grantee_id = groupId
    } else {
      body.grantee_type = 'link'
    }

    createShare.mutate(body)
  }

  const copyLink = (token: string) => {
    void navigator.clipboard.writeText(`${window.location.origin}/shared/${token}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-[#2d3148]">
          <div>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100">Share</h2>
            <p className="text-xs text-muted truncate max-w-[280px]" title={item.name}>{item.name}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-zinc-100 dark:border-[#2d3148] px-5">
          {(['user', 'group', 'link'] as ShareTargetType[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`py-2.5 px-3 text-sm font-medium border-b-2 transition-colors capitalize ${
                tab === t
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-muted hover:text-zinc-700 dark:hover:text-slate-300'
              }`}
            >
              {t === 'link' ? 'Link' : t === 'group' ? 'Group' : 'User'}
            </button>
          ))}
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Target input */}
          {tab === 'user' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">Email address</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="user@example.com"
                className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          )}
          {tab === 'group' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">Group</label>
              <select
                value={groupId}
                onChange={e => setGroupId(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">Select a group…</option>
                {groups?.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          )}
          {tab === 'link' && (
            <p className="text-xs text-muted">
              Creates a public link that anyone with the URL can access. You can optionally password-protect it or set an expiry.
            </p>
          )}

          {/* Permissions */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-zinc-600 dark:text-slate-400">Permissions</p>
            <PermCheckboxes perms={perms} onChange={setPerms} isFolder={item.is_folder} />
          </div>

          {/* Expiry */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">Expiry</label>
              <button
                type="button"
                onClick={() => setHasExpiry(v => !v)}
                className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
              >
                {hasExpiry ? 'Remove expiry' : 'Set expiry'}
              </button>
            </div>
            {hasExpiry ? (
              <input
                type="datetime-local"
                value={expiry}
                onChange={e => setExpiry(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            ) : (
              <p className="text-xs text-muted">Never expires</p>
            )}
          </div>

          <button
            onClick={handleCreate}
            disabled={createShare.isPending || (tab === 'user' && !email) || (tab === 'group' && !groupId)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            <UserPlus size={14} />
            {createShare.isPending ? 'Sharing…' : 'Share'}
          </button>

          {/* Existing shares */}
          {shares && shares.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-zinc-100 dark:border-[#2d3148]">
              <p className="text-xs font-medium text-zinc-600 dark:text-slate-400">Active shares</p>
              <ul className="space-y-1.5">
                {shares.map(s => (
                  <ActiveShareRow
                    key={s.id}
                    s={s}
                    isFolder={item.is_folder}
                    copied={copied}
                    onRevoke={() => revokeShare.mutate(s.id)}
                    onCopyLink={s.grantee_type === 'link' ? () => copyLink(s.token ?? '') : undefined}
                    onUpdate={(editedPerms, expiresAt) =>
                      updateShare.mutate({
                        id: s.id,
                        body: {
                          can_view: editedPerms.can_view,
                          can_upload: editedPerms.can_upload,
                          can_edit: editedPerms.can_edit,
                          can_delete: editedPerms.can_delete,
                          can_reshare: editedPerms.can_reshare,
                          expires_at: expiresAt,
                        },
                      })
                    }
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
