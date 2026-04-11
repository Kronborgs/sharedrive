import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useRef } from 'react'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/utils'
import type { BackupPasswordStatus, GeneratedBackupPassword, RestoreResult } from '@/types/api'
import {
  Archive,
  Copy,
  Check,
  RefreshCw,
  Trash2,
  Upload,
  Download,
  AlertTriangle,
  ShieldCheck,
} from 'lucide-react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_auth/backup/')({
  component: BackupPage,
})

function BackupPage() {
  const qc = useQueryClient()
  const [newToken, setNewToken] = useState<string | null>(null)
  const [tokenCopied, setTokenCopied] = useState(false)
  const [exportToken, setExportToken] = useState('')
  const [restoreToken, setRestoreToken] = useState('')
  const [restoreFile, setRestoreFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data: status, isLoading } = useQuery({
    queryKey: ['backup', 'password'],
    queryFn: ({ signal }) => api.get<BackupPasswordStatus>('/api/v1/backup/password', signal),
  })

  const generateMutation = useMutation({
    mutationFn: () => api.post<GeneratedBackupPassword>('/api/v1/backup/password', {}),
    onSuccess: (data) => {
      setNewToken(data.token)
      setTokenCopied(false)
      void qc.invalidateQueries({ queryKey: ['backup', 'password'] })
    },
    onError: () => toast.error('Failed to generate backup password'),
  })

  const revokeMutation = useMutation({
    mutationFn: () => api.delete('/api/v1/backup/password'),
    onSuccess: () => {
      setNewToken(null)
      void qc.invalidateQueries({ queryKey: ['backup', 'password'] })
      toast.success('Backup password revoked')
    },
    onError: () => toast.error('Failed to revoke backup password'),
  })

  const handleCopyToken = async () => {
    if (!newToken) return
    await navigator.clipboard.writeText(newToken)
    setTokenCopied(true)
    setTimeout(() => setTokenCopied(false), 2500)
  }

  const handleExport = async () => {
    if (!exportToken.trim()) {
      toast.error('Enter your backup token first')
      return
    }
    try {
      const response = await fetch('/api/v1/backup/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token: exportToken.trim() }),
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        toast.error(err.error ?? 'Export failed')
        return
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const now = new Date().toISOString().slice(0, 10)
      const a = document.createElement('a')
      a.href = url
      a.download = `sharedrive-backup-${now}.shdbak`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success('Backup downloaded')
    } catch {
      toast.error('Export failed')
    }
  }

  const handleRestore = async () => {
    if (!restoreToken.trim()) {
      toast.error('Enter your backup token')
      return
    }
    if (!restoreFile) {
      toast.error('Select a .shdbak file')
      return
    }
    const form = new FormData()
    form.append('token', restoreToken.trim())
    form.append('file', restoreFile)

    try {
      const response = await fetch('/api/v1/backup/restore', {
        method: 'POST',
        credentials: 'include',
        body: form,
      })
      const data: RestoreResult | { error: string } = await response.json()
      if (!response.ok) {
        toast.error((data as { error: string }).error ?? 'Restore failed')
        return
      }
      const r = data as RestoreResult
      toast.success(
        `Restored ${r.files_restored} file(s) and ${r.folders_restored} folder(s) ` +
        `(${formatBytes(r.bytes_restored)})` +
        (r.skipped > 0 ? ` · ${r.skipped} skipped (already exist)` : '')
      )
      void qc.invalidateQueries({ queryKey: ['files'] })
      void qc.invalidateQueries({ queryKey: ['me'] })
      setRestoreFile(null)
      setRestoreToken('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch {
      toast.error('Restore failed')
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100 flex items-center gap-2">
          <Archive size={20} />
          Backup
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-slate-400">
          Export an encrypted archive of all your files. Your backup token is the only key —
          store it somewhere safe. Without it the archive cannot be decrypted.
        </p>
      </div>

      {/* ── Backup password ─────────────────────────────────────────────── */}
      <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-brand-500" />
          <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">Backup token</h2>
        </div>

        {isLoading ? (
          <p className="text-sm text-zinc-400">Loading…</p>
        ) : status?.has_password ? (
          <div className="space-y-3">
            <p className="text-sm text-zinc-600 dark:text-slate-400">
              A backup token is active.
              {status.created_at && (
                <> Created {new Date(status.created_at).toLocaleDateString()}.</>
              )}
              {status.last_used_at && (
                <> Last used {new Date(status.last_used_at).toLocaleDateString()}.</>
              )}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (confirm('Generate a new token? The current one will be permanently revoked.')) {
                    generateMutation.mutate()
                  }
                }}
                disabled={generateMutation.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 dark:border-[#2d3148] text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-50"
              >
                <RefreshCw size={12} />
                Rotate token
              </button>
              <button
                onClick={() => {
                  if (confirm('Revoke your backup token? You will no longer be able to export or restore.')) {
                    revokeMutation.mutate()
                  }
                }}
                disabled={revokeMutation.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
              >
                <Trash2 size={12} />
                Revoke
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-zinc-500 dark:text-slate-400">No backup token yet.</p>
            <button
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
            >
              Generate token
            </button>
          </div>
        )}

        {/* New token reveal */}
        {newToken && (
          <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-2">
            <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <p className="text-sm font-medium">Save this token now — it will never be shown again.</p>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-white dark:bg-[#0f1117] border border-amber-200 dark:border-amber-800 rounded px-3 py-2 break-all text-zinc-800 dark:text-slate-200 select-all">
                {newToken}
              </code>
              <button
                onClick={handleCopyToken}
                className="shrink-0 p-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                title="Copy token"
              >
                {tokenCopied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── Export ──────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Download size={16} className="text-brand-500" />
          <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">Export backup</h2>
        </div>
        <p className="text-sm text-zinc-500 dark:text-slate-400">
          Downloads an AES-256 encrypted archive (<code className="text-xs">.shdbak</code>) containing
          all your files and metadata.
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            value={exportToken}
            onChange={e => setExportToken(e.target.value)}
            placeholder="Backup token"
            className="flex-1 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button
            onClick={handleExport}
            disabled={!exportToken.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
          >
            <Download size={14} />
            Download
          </button>
        </div>
      </section>

      {/* ── Restore ─────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Upload size={16} className="text-brand-500" />
          <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">Restore from backup</h2>
        </div>
        <p className="text-sm text-zinc-500 dark:text-slate-400">
          Upload a <code className="text-xs">.shdbak</code> file to restore files. Existing files
          are skipped — the operation is safe to repeat.
        </p>
        <div className="space-y-2">
          <input
            type="password"
            value={restoreToken}
            onChange={e => setRestoreToken(e.target.value)}
            placeholder="Backup token"
            className="w-full text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <div className="flex gap-2 items-center">
            <label className="flex-1 flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg border border-dashed border-zinc-300 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors">
              <Upload size={14} className="text-zinc-400" />
              <span className="text-sm text-zinc-500 dark:text-slate-400 truncate">
                {restoreFile ? restoreFile.name : 'Choose .shdbak file…'}
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".shdbak"
                className="hidden"
                onChange={e => setRestoreFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <button
              onClick={handleRestore}
              disabled={!restoreToken.trim() || !restoreFile}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
            >
              Restore
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
