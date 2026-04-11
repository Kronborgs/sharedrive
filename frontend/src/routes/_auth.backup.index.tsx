import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useRef, useEffect } from 'react'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/utils'
import type {
  BackupPasswordStatus,
  GeneratedBackupPassword,
  RestoreResult,
  BackupConfig,
  TertiaryArchive,
  BuddyArchive,
  BuddyUserConfig,
  GeneratedBuddyReceiveToken,
  AutoBackupConfig,
} from '@/types/api'
import type { FileItem } from '@/types/api'
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
  HardDrive,
  Server,
  Folder,
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Clock,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_auth/backup/')({
  component: BackupPage,
})

// ── file tree node (recursive) ───────────────────────────────────────────────

function FileTreeNode({
  item,
  depth,
  selectedIDs,
  onToggle,
}: {
  item: FileItem
  depth: number
  selectedIDs: string[]
  onToggle: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)

  const { data: children, isLoading: loadingChildren } = useQuery({
    queryKey: ['files', item.id, 'picker-children'],
    queryFn: ({ signal }) =>
      api.get<FileItem[]>(`/api/v1/files?parent_id=${item.id}`, signal),
    enabled: item.is_folder && expanded,
  })

  return (
    <div>
      <div
        className="flex items-center gap-1 py-0.5"
        style={{ paddingLeft: `${depth * 14}px` }}
      >
        {item.is_folder ? (
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            className="p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-200 transition-colors shrink-0"
          >
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <label className="flex items-center gap-1.5 cursor-pointer flex-1 min-w-0">
          <input
            type="checkbox"
            checked={selectedIDs.includes(item.id)}
            onChange={() => onToggle(item.id)}
            className="accent-brand-600 shrink-0"
          />
          {item.is_folder
            ? <Folder size={11} className="text-zinc-400 shrink-0" />
            : <FileIcon size={11} className="text-zinc-400 shrink-0" />}
          <span className="text-xs text-zinc-700 dark:text-slate-300 truncate">{item.name}</span>
        </label>
      </div>
      {expanded && item.is_folder && (
        loadingChildren
          ? <p className="text-xs text-zinc-400 py-0.5" style={{ paddingLeft: `${(depth + 1) * 14 + 20}px` }}>Loading…</p>
          : (children ?? []).map(c => (
              <FileTreeNode key={c.id} item={c} depth={depth + 1} selectedIDs={selectedIDs} onToggle={onToggle} />
            ))
      )}
    </div>
  )
}

// ── shared folder-picker component ───────────────────────────────────────────

function FolderPicker({
  selectedIDs,
  onChange,
}: {
  selectedIDs: string[]
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)

  const { data: rootItems, isLoading: pickerLoading } = useQuery({
    queryKey: ['files', 'root-for-picker'],
    queryFn: ({ signal }) =>
      api.get<FileItem[]>('/api/v1/files', signal),
    enabled: open,
  })

  const items = rootItems ?? []
  const allChecked = selectedIDs.length === 0

  const toggle = (id: string) => {
    if (selectedIDs.includes(id)) {
      onChange(selectedIDs.filter(x => x !== id))
    } else {
      onChange([...selectedIDs, id])
    }
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-slate-400 hover:text-zinc-700 dark:hover:text-slate-200 transition-colors"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {allChecked ? 'All files' : `${selectedIDs.length} item(s) selected`}
      </button>

      {open && (
        <div className="rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] p-3 space-y-1.5">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={() => onChange([])}
              className="accent-brand-600"
            />
            <span className="text-xs font-medium text-zinc-700 dark:text-slate-300">All files</span>
          </label>
          {pickerLoading && (
            <p className="text-xs text-zinc-400 pt-1">Loading…</p>
          )}
          {!pickerLoading && items.length > 0 && (
            <div className="border-t border-zinc-200 dark:border-[#2d3148] pt-1.5">
              {items.map(item => (
                <FileTreeNode
                  key={item.id}
                  item={item}
                  depth={0}
                  selectedIDs={selectedIDs}
                  onToggle={toggle}
                />
              ))}
            </div>
          )}
          {!pickerLoading && items.length === 0 && (
            <p className="text-xs text-zinc-400 pt-1">No files yet</p>
          )}
        </div>
      )}
    </div>
  )
}

// ── main page ─────────────────────────────────────────────────────────────────

function BackupPage() {
  const qc = useQueryClient()

  // password token state
  const [newToken, setNewToken] = useState<string | null>(null)
  const [tokenCopied, setTokenCopied] = useState(false)

  // export state
  const [exportToken, setExportToken] = useState('')
  const [exportFolderIDs, setExportFolderIDs] = useState<string[]>([])

  // restore state
  const [restoreToken, setRestoreToken] = useState('')
  const [restoreFile, setRestoreFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // tertiary state
  const [tertiaryToken, setTertiaryToken] = useState('')
  const [tertiaryFolderIDs, setTertiaryFolderIDs] = useState<string[]>([])
  const [tertiarySaving, setTertiarySaving] = useState(false)

  // buddy push state
  const [buddyToken, setBuddyToken] = useState('')
  const [buddyFolderIDs, setBuddyFolderIDs] = useState<string[]>([])
  const [buddyPushing, setBuddyPushing] = useState(false)

  // auto backup folder state
  const [autoFolderIDs, setAutoFolderIDs] = useState<string[]>([])

  // buddy config state
  const [newReceiveToken, setNewReceiveToken] = useState<string | null>(null)
  const [receiveTokenCopied, setReceiveTokenCopied] = useState(false)
  const [peerURLInput, setPeerURLInput] = useState('')

  // Restore token from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('sharedrive_backup_token')
    if (saved) {
      setExportToken(saved)
      setRestoreToken(saved)
      setTertiaryToken(saved)
      setBuddyToken(saved)
    }
  }, [])

  // Persist token to localStorage whenever any token field changes
  const saveToken = (t: string) => {
    if (t) localStorage.setItem('sharedrive_backup_token', t)
  }

  const [peerUserIDInput, setPeerUserIDInput] = useState('')
  const [peerTokenInput, setPeerTokenInput] = useState('')

  // ── queries ──────────────────────────────────────────────────────────────

  const { data: status, isLoading } = useQuery({
    queryKey: ['backup', 'password'],
    queryFn: ({ signal }) => api.get<BackupPasswordStatus>('/api/v1/backup/password', signal),
  })

  const { data: config } = useQuery({
    queryKey: ['backup', 'config'],
    queryFn: ({ signal }) => api.get<BackupConfig>('/api/v1/backup/config', signal),
  })

  const { data: tertiaryList, refetch: refetchTertiary } = useQuery({
    queryKey: ['backup', 'tertiary'],
    queryFn: ({ signal }) => api.get<TertiaryArchive[]>('/api/v1/backup/tertiary', signal),
    enabled: config?.tertiary_enabled ?? false,
  })

  const { data: autoConfig, refetch: refetchAutoConfig } = useQuery({
    queryKey: ['backup', 'auto'],
    queryFn: ({ signal }) => api.get<AutoBackupConfig>('/api/v1/backup/auto', signal),
    enabled: config?.tertiary_enabled ?? false,
  })

  // Sync auto folder IDs when config loads
  useEffect(() => {
    if (autoConfig?.folder_ids) setAutoFolderIDs(autoConfig.folder_ids)
  }, [autoConfig?.folder_ids])

  const { data: buddyConfig, refetch: refetchBuddyConfig } = useQuery({
    queryKey: ['backup', 'buddy-config'],
    queryFn: ({ signal }) => api.get<BuddyUserConfig>('/api/v1/backup/buddy/config', signal),
  })

  const { data: buddyReceived, refetch: refetchBuddyReceived } = useQuery({
    queryKey: ['backup', 'buddy-received'],
    queryFn: ({ signal }) => api.get<BuddyArchive[]>('/api/v1/backup/buddy/received', signal),
    enabled: buddyConfig?.has_receive_token ?? false,
  })

  // ── mutations ─────────────────────────────────────────────────────────────

  const generateMutation = useMutation({
    mutationFn: () => api.post<GeneratedBackupPassword>('/api/v1/backup/password', {}),
    onSuccess: (data) => {
      setNewToken(data.token)
      setTokenCopied(false)
      // Auto-fill token into all fields so the user can act immediately
      setExportToken(data.token)
      setRestoreToken(data.token)
      setTertiaryToken(data.token)
      setBuddyToken(data.token)
      localStorage.setItem('sharedrive_backup_token', data.token)
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

  const deleteTertiaryMutation = useMutation({
    mutationFn: (filename: string) => api.delete(`/api/v1/backup/tertiary/${encodeURIComponent(filename)}`),
    onSuccess: () => { void refetchTertiary(); toast.success('Archive deleted') },
    onError: () => toast.error('Delete failed'),
  })

  const deleteBuddyMutation = useMutation({
    mutationFn: (filename: string) => api.delete(`/api/v1/backup/buddy/received/${encodeURIComponent(filename)}`),
    onSuccess: () => { void refetchBuddyReceived(); toast.success('Archive deleted') },
    onError: () => toast.error('Delete failed'),
  })

  const saveAutoConfigMutation = useMutation({
    mutationFn: (body: { enabled: boolean; interval_hours: number; folder_ids: string[] }) =>
      api.put('/api/v1/backup/auto', body),
    onSuccess: () => { void refetchAutoConfig(); toast.success('Auto backup settings saved') },
    onError: () => toast.error('Failed to save auto backup settings'),
  })

  const generateReceiveTokenMutation = useMutation({
    mutationFn: () => api.post<GeneratedBuddyReceiveToken>('/api/v1/backup/buddy/receive-token', {}),
    onSuccess: (data) => {
      setNewReceiveToken(data.token)
      setReceiveTokenCopied(false)
      void refetchBuddyConfig()
    },
    onError: () => toast.error('Failed to generate receive token'),
  })

  const revokeReceiveTokenMutation = useMutation({
    mutationFn: () => api.delete('/api/v1/backup/buddy/receive-token'),
    onSuccess: () => {
      setNewReceiveToken(null)
      void refetchBuddyConfig()
      toast.success('Receive token revoked')
    },
    onError: () => toast.error('Failed to revoke receive token'),
  })

  const savePeerConfigMutation = useMutation({
    mutationFn: () => api.put('/api/v1/backup/buddy/config', {
      peer_url: peerURLInput.trim(),
      peer_user_id: peerUserIDInput.trim(),
      peer_token: peerTokenInput.trim(),
    }),
    onSuccess: () => {
      void refetchBuddyConfig()
      setPeerURLInput(''); setPeerUserIDInput(''); setPeerTokenInput('')
      toast.success('Peer configuration saved')
    },
    onError: () => toast.error('Failed to save peer configuration'),
  })

  const clearPeerConfigMutation = useMutation({
    mutationFn: () => api.delete('/api/v1/backup/buddy/config'),
    onSuccess: () => {
      void refetchBuddyConfig()
      setBuddyToken('')
      toast.success('Peer configuration cleared')
    },
    onError: () => toast.error('Failed to clear peer configuration'),
  })

  // ── handlers ──────────────────────────────────────────────────────────────

  const handleCopyToken = async () => {
    if (!newToken) return
    await navigator.clipboard.writeText(newToken)
    setTokenCopied(true)
    setTimeout(() => setTokenCopied(false), 2500)
  }

  const handleExport = async () => {
    if (!exportToken.trim()) { toast.error('Enter your backup token first'); return }
    try {
      const response = await fetch('/api/v1/backup/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          token: exportToken.trim(),
          ...(exportFolderIDs.length > 0 && { folder_ids: exportFolderIDs }),
        }),
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        toast.error((err as { error?: string }).error ?? 'Export failed')
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
    } catch { toast.error('Export failed') }
  }

  const handleRestore = async () => {
    if (!restoreToken.trim()) { toast.error('Enter your backup token'); return }
    if (!restoreFile) { toast.error('Select a .shdbak file'); return }
    const form = new FormData()
    form.append('token', restoreToken.trim())
    form.append('file', restoreFile)
    try {
      const response = await fetch('/api/v1/backup/restore', {
        method: 'POST', credentials: 'include', body: form,
      })
      const data = await response.json() as RestoreResult | { error: string }
      if (!response.ok) { toast.error((data as { error: string }).error ?? 'Restore failed'); return }
      const r = data as RestoreResult
      toast.success(
        `Restored ${r.files_restored} file(s) and ${r.folders_restored} folder(s) ` +
        `(${formatBytes(r.bytes_restored)})` +
        (r.skipped > 0 ? ` · ${r.skipped} skipped` : '')
      )
      void qc.invalidateQueries({ queryKey: ['files'] })
      void qc.invalidateQueries({ queryKey: ['me'] })
      setRestoreFile(null); setRestoreToken('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch { toast.error('Restore failed') }
  }

  const handleStoreTertiary = async () => {
    if (!tertiaryToken.trim()) { toast.error('Enter your backup token'); return }
    setTertiarySaving(true)
    try {
      await api.post('/api/v1/backup/tertiary', {
        token: tertiaryToken.trim(),
        ...(tertiaryFolderIDs.length > 0 && { folder_ids: tertiaryFolderIDs }),
      })
      toast.success('Archive saved to server storage')
      void refetchTertiary()
    } catch (e: unknown) {
      toast.error((e as Error).message ?? 'Failed to save archive')
    } finally {
      setTertiarySaving(false)
    }
  }

  const handleCopyReceiveToken = async () => {
    if (!newReceiveToken) return
    await navigator.clipboard.writeText(newReceiveToken)
    setReceiveTokenCopied(true)
    setTimeout(() => setReceiveTokenCopied(false), 2500)
  }

  const handleBuddyPush = async () => {
    if (!buddyToken.trim()) { toast.error('Enter your backup token'); return }
    if (!status?.has_password) { toast.error('Generate a backup token first'); return }
    setBuddyPushing(true)
    try {
      await api.post('/api/v1/backup/buddy/push', {
        token: buddyToken.trim(),
        ...(buddyFolderIDs.length > 0 && { folder_ids: buddyFolderIDs }),
      })
      toast.success('Archive pushed to buddy server')
    } catch (e: unknown) {
      toast.error((e as Error).message ?? 'Buddy push failed')
    } finally {
      setBuddyPushing(false)
    }
  }

  // ── render ────────────────────────────────────────────────────────────────

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

      {/* ── Backup token ─────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-brand-500" />
          <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">Backup token</h2>
        </div>
        <p className="text-sm text-zinc-500 dark:text-slate-400">
          This password is used to extract encrypted backup archives outside Sharedrive.
        </p>
        <p className="text-sm text-zinc-500 dark:text-slate-400">
          Store it safely. It may be required for disaster recovery.
        </p>

        {isLoading ? (
          <p className="text-sm text-zinc-400">Loading…</p>
        ) : status?.has_password ? (
          <div className="space-y-3">
            <p className="text-sm text-zinc-600 dark:text-slate-400">
              A backup token is active.
              {status.created_at && <> Created {new Date(status.created_at).toLocaleDateString()}.</>}
              {status.last_used_at && <> Last used {new Date(status.last_used_at).toLocaleDateString()}.</>}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (confirm('Generate a new token? The current one will be permanently revoked. Existing backups encrypted with the old token will still require the old token to restore.')) {
                    generateMutation.mutate()
                  }
                }}
                disabled={generateMutation.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 dark:border-[#2d3148] text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-50"
              >
                <RefreshCw size={12} /> Rotate token
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
                <Trash2 size={12} /> Revoke
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

      {/* ── Export (download) ────────────────────────────────────────────── */}
      <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Download size={16} className="text-brand-500" />
          <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">Export backup</h2>
        </div>
        <p className="text-sm text-zinc-500 dark:text-slate-400">
          Downloads an AES-256 encrypted archive (<code className="text-xs">.shdbak</code>) to your device.
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            value={exportToken}
            onChange={e => { setExportToken(e.target.value); saveToken(e.target.value) }}
            placeholder="Backup token"
            className="flex-1 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button
            onClick={handleExport}
            disabled={!exportToken.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
          >
            <Download size={14} /> Download
          </button>
        </div>
        <FolderPicker selectedIDs={exportFolderIDs} onChange={setExportFolderIDs} />
      </section>

      {/* ── Restore ──────────────────────────────────────────────────────── */}
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

      {/* ── Tertiary — server storage ─────────────────────────────────────── */}
      <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
        <div className="flex items-center gap-2">
          <HardDrive size={16} className="text-brand-500" />
          <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">Server storage backup</h2>
        </div>
        <p className="text-sm text-zinc-500 dark:text-slate-400">
          Writes an encrypted archive directly to a mounted disk or storage box on the server.
        </p>

        {config?.tertiary_enabled && config.disk_total_bytes != null && config.disk_total_bytes > 0 && (
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-slate-400">
            <HardDrive size={12} />
            <span>
              {formatBytes(config.disk_free_bytes ?? 0)} free of {formatBytes(config.disk_total_bytes)}
            </span>
          </div>
        )}

        {!config?.tertiary_enabled ? (
          <div className="rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-4 py-3 text-xs text-zinc-500 dark:text-slate-400 space-y-1">
            <p className="font-medium text-zinc-700 dark:text-slate-300">Not configured</p>
            <p>Set <code className="bg-zinc-100 dark:bg-[#1a1d27] px-1 rounded">BACKUPS_ROOT=/mnt/backup</code> in your environment to enable this feature.</p>
          </div>
        ) : !status?.has_password ? (
          <div className="rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-400">
            Generate a backup token above before saving archives to server storage.
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              <input
                type="password"
                value={tertiaryToken}
                onChange={e => { setTertiaryToken(e.target.value); saveToken(e.target.value) }}
                placeholder="Backup token"
                className="flex-1 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <button
                onClick={handleStoreTertiary}
                disabled={!tertiaryToken.trim() || tertiarySaving}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
              >
                {tertiarySaving
                  ? <><RefreshCw size={14} className="animate-spin" /> Saving…</>
                  : <><HardDrive size={14} /> Save</>}
              </button>
            </div>
            <FolderPicker selectedIDs={tertiaryFolderIDs} onChange={setTertiaryFolderIDs} />

            {tertiaryList && tertiaryList.length > 0 && (
              <div className="space-y-1 pt-1">
                <p className="text-xs font-medium text-zinc-500 dark:text-slate-400">Stored archives</p>
                {tertiaryList.map(a => (
                  <div
                    key={a.filename}
                    className="flex items-center gap-2 rounded-lg border border-zinc-100 dark:border-[#2d3148] px-3 py-2 text-xs"
                  >
                    <span className="flex-1 font-mono text-zinc-700 dark:text-slate-300 truncate">{a.filename}</span>
                    <span className="text-zinc-400 shrink-0">{formatBytes(a.size_bytes)}</span>
                    <a
                      href={`/api/v1/backup/tertiary/${encodeURIComponent(a.filename)}`}
                      download={a.filename}
                      className="shrink-0 p-1 rounded hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors"
                      title="Download"
                    >
                      <Download size={12} />
                    </a>
                    <button
                      onClick={() => deleteTertiaryMutation.mutate(a.filename)}
                      className="shrink-0 p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {tertiaryList?.length === 0 && (
              <p className="text-xs text-zinc-400">No archives stored yet.</p>
            )}
          </>
        )}
      </section>

      {/* ── Auto backup schedule ──────────────────────────────────────────── */}
      {config?.tertiary_enabled && status?.has_password && (
        <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Clock size={16} className="text-brand-500" />
            <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">Automatic backup</h2>
          </div>
          <p className="text-sm text-zinc-500 dark:text-slate-400">
            Schedule automatic backups to server storage. A new archive is only created when your files have changed.
          </p>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-700 dark:text-slate-300">Enable auto backup</span>
              <button
                type="button"
                onClick={() => saveAutoConfigMutation.mutate({
                  enabled: !(autoConfig?.enabled ?? false),
                  interval_hours: autoConfig?.interval_hours ?? 24,
                  folder_ids: autoFolderIDs,
                })}
                className="transition-colors"
                title={autoConfig?.enabled ? 'Disable' : 'Enable'}
              >
                {autoConfig?.enabled
                  ? <ToggleRight size={28} className="text-brand-500" />
                  : <ToggleLeft size={28} className="text-zinc-400" />}
              </button>
            </div>

            <div className="flex items-center gap-3">
              <label className="text-xs text-zinc-500 dark:text-slate-400 shrink-0">Interval</label>
              <select
                value={autoConfig?.interval_hours ?? 24}
                onChange={e => saveAutoConfigMutation.mutate({
                  enabled: autoConfig?.enabled ?? false,
                  interval_hours: Number(e.target.value),
                  folder_ids: autoFolderIDs,
                })}
                className="text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] px-3 py-1.5 text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500 [&>option]:bg-white [&>option]:dark:bg-[#1a1d27] [&>option]:text-zinc-900 [&>option]:dark:text-slate-100"
              >
                <option value={6}>Every 6 hours</option>
                <option value={12}>Every 12 hours</option>
                <option value={24}>Every 24 hours</option>
                <option value={48}>Every 48 hours</option>
                <option value={168}>Weekly</option>
              </select>
            </div>

            <FolderPicker selectedIDs={autoFolderIDs} onChange={ids => {
              setAutoFolderIDs(ids)
              saveAutoConfigMutation.mutate({
                enabled: autoConfig?.enabled ?? false,
                interval_hours: autoConfig?.interval_hours ?? 24,
                folder_ids: ids,
              })
            }} />

            {autoConfig?.last_run_at && (
              <p className="text-xs text-zinc-400">
                Last auto-backup: {new Date(autoConfig.last_run_at).toLocaleString()}
              </p>
            )}
          </div>
        </section>
      )}

      {/* ── Buddy backup ──────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-5">
        <div className="flex items-center gap-2">
          <Server size={16} className="text-brand-500" />
          <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">Buddy backup</h2>
        </div>
        <p className="text-sm text-zinc-500 dark:text-slate-400">
          Push encrypted archives to a peer Sharedrive server for off-site redundancy.
          Exchange your receive info with a trusted friend — they configure your details on their side, you configure theirs on yours.
        </p>

        {/* ── Your receive info ─────────────────────────────────────────── */}
        <div className="space-y-3 border-t border-zinc-100 dark:border-[#2d3148] pt-4">
          <p className="text-xs font-semibold text-zinc-700 dark:text-slate-300">Your receive info — share with your buddy</p>
          <p className="text-xs text-zinc-500 dark:text-slate-400">Give these three values to your buddy so they can push archives to you.</p>

          {/* URL */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500 dark:text-slate-400 w-20 shrink-0">Server URL</span>
            <code className="flex-1 text-xs font-mono bg-zinc-50 dark:bg-[#0f1117] border border-zinc-200 dark:border-[#2d3148] rounded px-2 py-1 truncate">{window.location.origin}</code>
            <button
              onClick={() => { void navigator.clipboard.writeText(window.location.origin); toast.success('URL copied') }}
              className="shrink-0 p-1.5 rounded border border-zinc-200 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
              title="Copy URL"
            >
              <Copy size={12} />
            </button>
          </div>

          {/* User ID */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500 dark:text-slate-400 w-20 shrink-0">Your User ID</span>
            <code className="flex-1 text-xs font-mono bg-zinc-50 dark:bg-[#0f1117] border border-zinc-200 dark:border-[#2d3148] rounded px-2 py-1 truncate">{buddyConfig?.user_id ?? '…'}</code>
            <button
              onClick={() => { if (buddyConfig?.user_id) { void navigator.clipboard.writeText(buddyConfig.user_id); toast.success('User ID copied') } }}
              className="shrink-0 p-1.5 rounded border border-zinc-200 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
              title="Copy User ID"
            >
              <Copy size={12} />
            </button>
          </div>

          {/* Receive token */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500 dark:text-slate-400 w-20 shrink-0">Receive token</span>
            {buddyConfig?.has_receive_token ? (
              <span className="flex-1 text-xs font-mono text-zinc-500 dark:text-slate-400">
                {buddyConfig.receive_token_prefix}••••••••••••••••••••••••••••••••••••
              </span>
            ) : (
              <span className="flex-1 text-xs text-zinc-400">Not generated yet</span>
            )}
            <button
              onClick={() => generateReceiveTokenMutation.mutate()}
              disabled={generateReceiveTokenMutation.isPending}
              className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-zinc-200 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-50"
            >
              <RefreshCw size={10} /> {buddyConfig?.has_receive_token ? 'Rotate' : 'Generate'}
            </button>
            {buddyConfig?.has_receive_token && (
              <button
                onClick={() => { if (confirm('Revoke receive token? Your buddy will no longer be able to push archives to you.')) revokeReceiveTokenMutation.mutate() }}
                disabled={revokeReceiveTokenMutation.isPending}
                className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
              >
                <Trash2 size={10} /> Revoke
              </button>
            )}
          </div>

          {newReceiveToken && (
            <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-2">
              <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <p className="text-xs font-medium">Save this token now — it will never be shown again. Give it to your buddy.</p>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-white dark:bg-[#0f1117] border border-amber-200 dark:border-amber-800 rounded px-3 py-2 break-all text-zinc-800 dark:text-slate-200 select-all">
                  {newReceiveToken}
                </code>
                <button
                  onClick={handleCopyReceiveToken}
                  className="shrink-0 p-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                  title="Copy token"
                >
                  {receiveTokenCopied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Push to peer ──────────────────────────────────────────────── */}
        <div className="space-y-3 border-t border-zinc-100 dark:border-[#2d3148] pt-4">
          <p className="text-xs font-semibold text-zinc-700 dark:text-slate-300">Push to peer</p>
          <p className="text-xs text-zinc-500 dark:text-slate-400">Enter the receive info your buddy gave you.</p>

          {buddyConfig?.peer_configured ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg bg-zinc-50 dark:bg-[#0f1117] border border-zinc-200 dark:border-[#2d3148] px-3 py-2">
                <span className="text-xs text-zinc-500 dark:text-slate-400">Peer:</span>
                <span className="flex-1 text-xs font-mono text-zinc-700 dark:text-slate-300 truncate">{buddyConfig.peer_url}</span>
                <button
                  onClick={() => { if (confirm('Clear peer configuration? You will no longer be able to push to this peer.')) clearPeerConfigMutation.mutate() }}
                  disabled={clearPeerConfigMutation.isPending}
                  className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                >
                  <Trash2 size={10} /> Clear
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={buddyToken}
                  onChange={e => { setBuddyToken(e.target.value); saveToken(e.target.value) }}
                  placeholder="Your backup token"
                  className="flex-1 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <button
                  onClick={handleBuddyPush}
                  disabled={!buddyToken.trim() || buddyPushing}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
                >
                  {buddyPushing
                    ? <><RefreshCw size={14} className="animate-spin" /> Pushing…</>
                    : <><Server size={14} /> Push</>}
                </button>
              </div>
              <FolderPicker selectedIDs={buddyFolderIDs} onChange={setBuddyFolderIDs} />
            </div>
          ) : (
            <div className="space-y-2">
              <input
                type="url"
                value={peerURLInput}
                onChange={e => setPeerURLInput(e.target.value)}
                placeholder="Peer server URL (e.g. https://peer.example.com)"
                className="w-full text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <input
                type="text"
                value={peerUserIDInput}
                onChange={e => setPeerUserIDInput(e.target.value)}
                placeholder="Peer user ID (UUID from their backup page)"
                className="w-full text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <div className="flex gap-2">
                <input
                  type="password"
                  value={peerTokenInput}
                  onChange={e => setPeerTokenInput(e.target.value)}
                  placeholder="Peer receive token (from their backup page)"
                  className="flex-1 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <button
                  onClick={() => savePeerConfigMutation.mutate()}
                  disabled={!peerURLInput.trim() || !peerUserIDInput.trim() || !peerTokenInput.trim() || savePeerConfigMutation.isPending}
                  className="shrink-0 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Received buddy archives ───────────────────────────────────────── */}
      <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Server size={16} className="text-brand-500" />
          <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">Received buddy archives</h2>
        </div>
        <p className="text-sm text-zinc-500 dark:text-slate-400">
          Archives pushed here by your buddy. Download and restore to recover files.
        </p>

        {!buddyConfig?.has_receive_token ? (
          <p className="text-xs text-zinc-400 dark:text-slate-500">Generate a receive token above to allow your buddy to push archives here.</p>
        ) : buddyReceived && buddyReceived.length > 0 ? (
          <div className="space-y-1">
            {buddyReceived.map(a => (
              <div
                key={a.filename}
                className="flex items-center gap-2 rounded-lg border border-zinc-100 dark:border-[#2d3148] px-3 py-2 text-xs"
              >
                <span className="flex-1 font-mono text-zinc-700 dark:text-slate-300 truncate">{a.filename}</span>
                <span className="text-zinc-400 shrink-0">{formatBytes(a.size_bytes)}</span>
                <span className="text-zinc-400 shrink-0">{new Date(a.received_at).toLocaleDateString()}</span>
                <a
                  href={`/api/v1/backup/buddy/received/${encodeURIComponent(a.filename)}`}
                  download={a.filename}
                  className="shrink-0 p-1 rounded hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors"
                  title="Download"
                >
                  <Download size={12} />
                </a>
                <button
                  onClick={() => deleteBuddyMutation.mutate(a.filename)}
                  className="shrink-0 p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                  title="Delete"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-zinc-400">No archives received yet.</p>
        )}
      </section>
    </div>
  )
}
