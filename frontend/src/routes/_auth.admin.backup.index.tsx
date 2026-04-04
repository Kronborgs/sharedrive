import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import { formatBytes, formatDate } from '@/lib/utils'
import { Download, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'

interface BackupMeta {
  size_bytes: number
  created_at: string
  version: string
}

export const Route = createFileRoute('/_auth/admin/backup/')({
  component: BackupPage,
})

function BackupPage() {
  const qc = useQueryClient()
  const [restoreFile, setRestoreFile] = useState<File | null>(null)

  const { data: backups, isLoading } = useQuery({
    queryKey: ['admin', 'backups'],
    queryFn: ({ signal }) => api.get<BackupMeta[]>('/api/v1/admin/backup', signal),
  })

  const createBackup = useMutation({
    mutationFn: () =>
      fetch('/api/v1/admin/backup', {
        method: 'POST',
        credentials: 'include',
      }).then(async r => {
        if (!r.ok) throw new Error('Backup failed')
        const blob = await r.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `sharedrive-backup-${new Date().toISOString().slice(0, 10)}.json.gz`
        a.click()
        URL.revokeObjectURL(url)
      }),
    onSuccess: () => {
      toast.success('Backup downloaded')
      void qc.invalidateQueries({ queryKey: ['admin', 'backups'] })
    },
    onError: () => toast.error('Backup failed'),
  })

  const restoreBackup = useMutation({
    mutationFn: async () => {
      if (!restoreFile) return
      const formData = new FormData()
      formData.append('backup', restoreFile)
      const r = await fetch('/api/v1/admin/backup/restore', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
      if (!r.ok) {
        const data = await r.json() as { error?: string }
        throw new Error(data.error ?? 'Restore failed')
      }
    },
    onSuccess: () => {
      toast.success('Restore complete — please reload the page')
      setRestoreFile(null)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">Backup &amp; Restore</h1>

      {/* Export */}
      <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">Export</h2>
        <p className="text-sm text-muted">
          Downloads a compressed JSON backup of all users, groups, shares, and system settings.
          File content is <strong>not</strong> included — only metadata.
        </p>
        <button
          onClick={() => createBackup.mutate()}
          disabled={createBackup.isPending}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          <Download size={15} />
          {createBackup.isPending ? 'Creating…' : 'Create &amp; Download Backup'}
        </button>
      </section>

      {/* Previous backups */}
      <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-100 dark:border-[#2d3148]">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">Previous Exports</h2>
        </div>
        {isLoading ? (
          <div className="p-6 text-sm text-muted text-center">Loading…</div>
        ) : !backups?.length ? (
          <div className="p-6 text-sm text-muted text-center">No previous backups</div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
            {backups.map((b, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-3 text-sm">
                <div className="flex-1 min-w-0">
                  <p className="text-zinc-900 dark:text-slate-100">{formatDate(b.created_at)}</p>
                  <p className="text-xs text-muted">{formatBytes(b.size_bytes)} · version {b.version}</p>
                </div>
                <a
                  href={`/api/v1/admin/backup/${i}/download`}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/20 transition-colors"
                  title="Download"
                >
                  <Download size={14} />
                </a>
                <button
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Restore */}
      <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">Restore</h2>
        <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300">
          <strong>Warning:</strong> Restore will overwrite existing users, groups, shares, and settings.
          File contents are not affected. This action cannot be undone.
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors">
            <Upload size={14} />
            {restoreFile ? restoreFile.name : 'Choose backup file…'}
            <input
              type="file"
              accept=".json,.gz,.json.gz"
              className="sr-only"
              onChange={e => setRestoreFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {restoreFile && (
            <button
              onClick={() => {
                if (confirm('Are you sure you want to restore from this backup? This will overwrite current data.')) {
                  restoreBackup.mutate()
                }
              }}
              disabled={restoreBackup.isPending}
              className="px-4 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              {restoreBackup.isPending ? 'Restoring…' : 'Restore'}
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
