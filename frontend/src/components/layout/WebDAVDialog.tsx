import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { AppPassword, CreatedAppPassword } from '@/types/api'
import { X, Copy, Check, Trash2, Plus, HardDrive } from 'lucide-react'
import { toast } from 'sonner'
import { formatDate } from '@/lib/utils'

interface Props {
  onClose: () => void
}

export function WebDAVDialog({ onClose }: Props) {
  const qc = useQueryClient()
  const [newName, setNewName] = useState('')
  const [revealed, setRevealed] = useState<CreatedAppPassword | null>(null)
  const [copied, setCopied] = useState<'url' | 'pwd' | null>(null)

  const davUrl = `${window.location.origin}/dav`

  const { data: passwords } = useQuery({
    queryKey: ['app-passwords'],
    queryFn: ({ signal }) => api.get<AppPassword[]>('/api/v1/me/app-passwords', signal),
  })

  const create = useMutation({
    mutationFn: (name: string) =>
      api.post<CreatedAppPassword>('/api/v1/me/app-passwords', { name, scope: 'webdav' }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['app-passwords'] })
      setRevealed(data)
      setNewName('')
    },
    onError: () => toast.error('Failed to create app password'),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/me/app-passwords/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['app-passwords'] }),
    onError: () => toast.error('Failed to revoke app password'),
  })

  const copy = (text: string, key: 'url' | 'pwd') => {
    void navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-[#2d3148]">
          <div className="flex items-center gap-2">
            <HardDrive size={16} className="text-brand-500" />
            <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100">WebDAV Access</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-5 overflow-y-auto flex-1">
          {/* WebDAV URL */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-zinc-600 dark:text-slate-400">WebDAV URL</p>
            <div className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-2">
              <span className="flex-1 text-sm text-zinc-900 dark:text-slate-100 truncate font-mono">{davUrl}</span>
              <button
                onClick={() => copy(davUrl, 'url')}
                className="shrink-0 p-1 rounded text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
                title="Copy URL"
              >
                {copied === 'url' ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <p className="text-[11px] text-muted">
              Use this URL in Windows (Map Network Drive), macOS Finder (Connect to Server), or any WebDAV client.
              Log in with your <strong>email address</strong> and an <strong>app password</strong> below.
            </p>
          </div>

          {/* Revealed new password — show once */}
          {revealed && (
            <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2">
              <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                Copy this password now — it won't be shown again
              </p>
              <div className="flex items-center gap-2 rounded border border-amber-200 dark:border-amber-700 bg-white dark:bg-[#0f1117] px-3 py-1.5">
                <span className="flex-1 text-sm font-mono text-zinc-900 dark:text-slate-100 break-all">{revealed.password}</span>
                <button
                  onClick={() => copy(revealed.password, 'pwd')}
                  className="shrink-0 p-1 rounded text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
                >
                  {copied === 'pwd' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
              <button
                onClick={() => setRevealed(null)}
                className="text-[11px] text-amber-700 dark:text-amber-400 hover:underline"
              >
                I've saved it, dismiss
              </button>
            </div>
          )}

          {/* Create new app password */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-zinc-600 dark:text-slate-400">Create app password</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Windows PC, iPhone…"
                className="flex-1 rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) create.mutate(newName.trim()) }}
              />
              <button
                onClick={() => { if (newName.trim()) create.mutate(newName.trim()) }}
                disabled={!newName.trim() || create.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                <Plus size={14} />
                Create
              </button>
            </div>
          </div>

          {/* Existing app passwords */}
          {passwords && passwords.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-zinc-600 dark:text-slate-400">Active app passwords</p>
              <ul className="space-y-1">
                {passwords.map(p => (
                  <li key={p.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-50 dark:bg-[#0f1117]">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-900 dark:text-slate-100 truncate">{p.name}</p>
                      <p className="text-[11px] text-muted">
                        {p.last_used_at ? `Last used ${formatDate(p.last_used_at)}` : 'Never used'}
                        {' · '}Created {formatDate(p.created_at)}
                      </p>
                    </div>
                    <button
                      onClick={() => revoke.mutate(p.id)}
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
