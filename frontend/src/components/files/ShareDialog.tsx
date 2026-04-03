import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { FileItem, Share, SharePermissions, Group } from '@/types/api'
import { formatDate } from '@/lib/utils'
import { X, Check, Link, Trash2, UserPlus } from 'lucide-react'
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

export function ShareDialog({ item, onClose }: ShareDialogProps) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<ShareTargetType>('user')
  const [email, setEmail] = useState('')
  const [groupId, setGroupId] = useState('')
  const [perms, setPerms] = useState<SharePermissions>(DEFAULT_PERMS)
  const [expiry, setExpiry] = useState('')
  const [copied, setCopied] = useState(false)

  const { data: shares } = useQuery({
    queryKey: ['shares', item.id],
    queryFn: ({ signal }) => api.get<Share[]>(`/api/v1/files/${item.id}/shares`, signal),
  })

  const { data: groups } = useQuery({
    queryKey: ['groups'],
    queryFn: ({ signal }) => api.get<Group[]>('/api/v1/groups', signal),
  })

  const createShare = useMutation({
    mutationFn: (body: object) => api.post<Share>(`/api/v1/files/${item.id}/shares`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shares', item.id] })
      void qc.invalidateQueries({ queryKey: ['files'] })
      setEmail('')
    },
    onError: () => toast.error('Failed to create share'),
  })

  const revokeShare = useMutation({
    mutationFn: (shareId: string) => api.delete(`/api/v1/shares/${shareId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shares', item.id] })
      void qc.invalidateQueries({ queryKey: ['files'] })
    },
    onError: () => toast.error('Failed to revoke share'),
  })

  const handleCreate = () => {
    const body: Record<string, unknown> = {
      permissions: perms,
      expires_at: expiry || null,
    }

    if (tab === 'user') {
      body.grantee_type = 'user'
      body.grantee_email = email
    } else if (tab === 'group') {
      body.grantee_type = 'group'
      body.grantee_group_id = groupId
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
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {(Object.keys(DEFAULT_PERMS) as (keyof SharePermissions)[]).map(key => (
                <label key={key} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={perms[key]}
                    onChange={e => setPerms(prev => ({ ...prev, [key]: e.target.checked }))}
                    className="rounded border-zinc-300 dark:border-[#4d5678] text-brand-600"
                  />
                  <span className="text-xs text-zinc-700 dark:text-slate-300 capitalize">
                    {key.replace('can_', '')}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Expiry */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">Expires (optional)</label>
            <input
              type="datetime-local"
              value={expiry}
              onChange={e => setExpiry(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
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
                  <li key={s.id} className="flex items-center gap-2 p-2 rounded-lg bg-zinc-50 dark:bg-[#0f1117]">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-zinc-900 dark:text-slate-100 truncate">
                        {s.grantee_type === 'link' ? 'Public link' : s.grantee_email ?? s.grantee_group_name ?? 'Unknown'}
                      </p>
                      {s.expires_at && (
                        <p className="text-[10px] text-muted">Expires {formatDate(s.expires_at)}</p>
                      )}
                    </div>
                    {s.grantee_type === 'link' && (
                      <button
                        onClick={() => copyLink(s.token ?? '')}
                        className="p-1 rounded text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
                        title="Copy link"
                      >
                        {copied ? <Check size={13} /> : <Link size={13} />}
                      </button>
                    )}
                    <button
                      onClick={() => revokeShare.mutate(s.id)}
                      className="p-1 rounded text-zinc-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                      title="Revoke"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
