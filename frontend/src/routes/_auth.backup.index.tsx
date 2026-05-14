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
  ArrowUpToLine,
  ArrowDownToLine,
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
  ancestorIDs,
  allChecked,
}: {
  item: FileItem
  depth: number
  selectedIDs: string[]
  onToggle: (id: string) => void
  ancestorIDs: Set<string>
  allChecked: boolean
}) {
  const isAncestor = ancestorIDs.has(item.id)
  const isChecked = allChecked || selectedIDs.includes(item.id) || isAncestor
  // Auto-expand when allChecked so the user can see the full tree
  const [expanded, setExpanded] = useState(isAncestor || allChecked)

  useEffect(() => {
    if (isAncestor || allChecked) setExpanded(true)
  }, [isAncestor, allChecked])

  const { data: children, isLoading: loadingChildren } = useQuery({
    queryKey: ['files', item.id, 'picker-children'],
    queryFn: ({ signal }) =>
      api.get<FileItem[]>(`/api/v1/files?parent_id=${item.id}`, signal),
    enabled: item.is_folder && expanded,
  })

  return (
    <div>
      <div
        className={`flex items-center gap-1 py-1 rounded-md px-1 transition-colors ${
          isChecked
            ? 'bg-brand-50 dark:bg-brand-900/20'
            : 'hover:bg-zinc-100 dark:hover:bg-[#2d3148]/50'
        }`}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
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
          <span className={`flex items-center justify-center w-4 h-4 rounded shrink-0 border transition-colors ${
            isChecked
              ? 'bg-brand-600 border-brand-600'
              : 'border-zinc-300 dark:border-[#4a5070] bg-white dark:bg-[#1a1d27]'
          }`}>
            {isChecked && (
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </span>
          <input
            type="checkbox"
            checked={isChecked}
            onChange={() => onToggle(item.id)}
            className="sr-only"
          />
          {item.is_folder
            ? <Folder size={12} className={isChecked ? 'text-brand-500 shrink-0' : 'text-zinc-400 shrink-0'} />
            : <FileIcon size={12} className={isChecked ? 'text-brand-400 shrink-0' : 'text-zinc-400 shrink-0'} />}
          <span className={`text-xs truncate ${isChecked ? 'text-brand-700 dark:text-brand-300 font-medium' : 'text-zinc-700 dark:text-slate-300'}`}>
            {item.name}
          </span>
        </label>
      </div>
      {expanded && item.is_folder && (
        loadingChildren
          ? <p className="text-xs text-zinc-400 py-0.5" style={{ paddingLeft: `${(depth + 1) * 14 + 20}px` }}>Loading…</p>
          : (children ?? []).map(c => (
              <FileTreeNode key={c.id} item={c} depth={depth + 1} selectedIDs={selectedIDs} onToggle={onToggle} ancestorIDs={ancestorIDs} allChecked={allChecked} />
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

  /* compute ancestor folder IDs so we can auto-expand & visually check parents */
  const { data: ancestorIDs } = useQuery({
    queryKey: ['files', 'ancestors', selectedIDs.slice().sort().join(',')],
    queryFn: async ({ signal }) => {
      const results = await Promise.all(
        selectedIDs.map(id =>
          api.get<{ id: string; name: string }[]>(
            `/api/v1/files/breadcrumbs?folder_id=${id}`,
            signal,
          ),
        ),
      )
      const set = new Set<string>()
      for (const crumbs of results) {
        for (const c of crumbs) set.add(c.id)
      }
      for (const id of selectedIDs) set.delete(id)
      return set
    },
    enabled: selectedIDs.length > 0,
  })

  const resolvedAncestors = ancestorIDs ?? new Set<string>()
  const items = rootItems ?? []
  const allChecked = selectedIDs.length === 0
  const totalChecked = selectedIDs.length + resolvedAncestors.size

  const toggle = (id: string) => {
    if (allChecked) {
      // Switching from "all" to explicit: select all root items except the clicked one
      const rootIds = items.map(i => i.id)
      onChange(rootIds.filter(x => x !== id))
    } else if (selectedIDs.includes(id)) {
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
        {allChecked ? 'All files' : `${totalChecked} item(s) selected`}
      </button>

      {open && (
        <div className="rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] p-2 space-y-0.5">
          <label className={`flex items-center gap-2 cursor-pointer rounded-md px-2 py-1.5 transition-colors ${
            allChecked ? 'bg-brand-50 dark:bg-brand-900/20' : 'hover:bg-zinc-100 dark:hover:bg-[#2d3148]/50'
          }`}>
            <span className={`flex items-center justify-center w-4 h-4 rounded shrink-0 border transition-colors ${
              allChecked
                ? 'bg-brand-600 border-brand-600'
                : 'border-zinc-300 dark:border-[#4a5070] bg-white dark:bg-[#1a1d27]'
            }`}>
              {allChecked && (
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                  <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </span>
            <input
              type="checkbox"
              checked={allChecked}
              onChange={() => onChange([])}
              className="sr-only"
            />
            <span className={`text-xs font-semibold ${allChecked ? 'text-brand-700 dark:text-brand-300' : 'text-zinc-700 dark:text-slate-300'}`}>
              All files
            </span>
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
                  ancestorIDs={resolvedAncestors}
                  allChecked={allChecked}
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

  // tab state
  const [activeTab, setActiveTab] = useState<'storage' | 'buddy' | 'token'>('storage')

  // buddy config state
  const [newReceiveToken, setNewReceiveToken] = useState<string | null>(null)
  const [receiveTokenCopied, setReceiveTokenCopied] = useState(false)
  const [peerURLInput, setPeerURLInput] = useState('')

  // Restore token from sessionStorage on mount (sessionStorage clears on tab close,
  // reducing XSS exposure compared to localStorage for this sensitive value)
  useEffect(() => {
    const saved = sessionStorage.getItem('sharedrive_backup_token')
    if (saved) {
      setExportToken(saved)
      setRestoreToken(saved)
      setTertiaryToken(saved)
      setBuddyToken(saved)
    }
  }, [])

  // Persist token to sessionStorage whenever any token field changes
  const saveToken = (t: string) => {
    if (t) sessionStorage.setItem('sharedrive_backup_token', t)
  }

  const [peerUserIDInput, setPeerUserIDInput] = useState('')
  const [peerTokenInput, setPeerTokenInput] = useState('')

  // ── queries ──────────────────────────────────────────────────────────────

  const { data: status, isLoading } = useQuery({
    queryKey: ['backup', 'password'],
    queryFn: ({ signal }) => api.get<BackupPasswordStatus>('/api/v1/backup/password', signal),
  })

  // Auto-switch to token tab when no token is set
  useEffect(() => {
    if (!isLoading && !status?.has_password) setActiveTab('token')
  }, [isLoading, status?.has_password])

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

  // Sync folder selection from persisted auto config
  useEffect(() => {
    if (autoConfig?.folder_ids) setTertiaryFolderIDs(autoConfig.folder_ids)
  }, [autoConfig?.folder_ids])

  const { data: buddyConfig, refetch: refetchBuddyConfig } = useQuery({
    queryKey: ['backup', 'buddy-config'],
    queryFn: ({ signal }) => api.get<BuddyUserConfig>('/api/v1/backup/buddy/config', signal),
    // Poll every 3 s while a push is in progress so the UI updates when it finishes.
    refetchInterval: (query) => (query.state.data?.push_in_progress ? 3000 : false),
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
      sessionStorage.setItem('sharedrive_backup_token', data.token)
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
    mutationFn: (body: { enabled: boolean; interval_hours: number; retention_days: number; folder_ids: string[] }) =>
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
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to save peer configuration'
      toast.error(msg)
    },
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
      // Server returned 202 — push is running in the background.
      // Refetch config immediately so polling kicks in (push_in_progress = true).
      void refetchBuddyConfig()
      toast.success('Push started — running in the background')
    } catch (e: unknown) {
      toast.error((e as Error).message ?? 'Buddy push failed')
    } finally {
      setBuddyPushing(false)
    }
  }

  // ── render ────────────────────────────────────────────────────────────────

  const hasToken = status?.has_password ?? false

  return (
    <div className="max-w-2xl space-y-6">
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

      {/* ── Tab bar ─────────────────────────────────────────────────────── */}
      <div className="flex border-b border-zinc-200 dark:border-[#2d3148]">
        <button
          type="button"
          onClick={() => hasToken && setActiveTab('storage')}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'storage'
              ? 'border-brand-500 text-brand-600 dark:text-brand-400'
              : !hasToken
                ? 'border-transparent text-zinc-300 dark:text-slate-600 cursor-not-allowed'
                : 'border-transparent text-zinc-500 dark:text-slate-400 hover:text-zinc-700 dark:hover:text-slate-200 cursor-pointer'
          }`}
        >
          <HardDrive size={14} /> Server Storage
        </button>
        <button
          type="button"
          onClick={() => hasToken && setActiveTab('buddy')}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'buddy'
              ? 'border-brand-500 text-brand-600 dark:text-brand-400'
              : !hasToken
                ? 'border-transparent text-zinc-300 dark:text-slate-600 cursor-not-allowed'
                : 'border-transparent text-zinc-500 dark:text-slate-400 hover:text-zinc-700 dark:hover:text-slate-200 cursor-pointer'
          }`}
        >
          <Server size={14} /> Buddy Backup
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('token')}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'token'
              ? 'border-brand-500 text-brand-600 dark:text-brand-400'
              : 'border-transparent text-zinc-500 dark:text-slate-400 hover:text-zinc-700 dark:hover:text-slate-200 cursor-pointer'
          }`}
        >
          <ShieldCheck size={14} /> Backup Token
        </button>
      </div>

      {/* ── Tab 1: Server Storage ───────────────────────────────────────── */}
      {activeTab === 'storage' && (
        !hasToken ? (
          <div className="rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 px-6 py-8 text-center space-y-3">
            <ShieldCheck size={32} className="mx-auto text-amber-500" />
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Backup token required</p>
            <p className="text-xs text-amber-600 dark:text-amber-500">
              Go to the <button type="button" onClick={() => setActiveTab('token')} className="underline font-medium">Backup Token</button> tab to generate your encryption token before using server storage backup.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {/* ── Tertiary — server storage ──────────────────────────────── */}
            <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
              <div className="flex items-center gap-2">
                <HardDrive size={16} className="text-brand-500" />
                <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">Server storage backup</h2>
              </div>
              <p className="text-sm text-zinc-500 dark:text-slate-400">
                Writes an encrypted archive directly to a mounted disk or storage box on the server.
              </p>
              <p className="text-xs text-zinc-400 dark:text-slate-500">
                Uses the backup token from the <button type="button" onClick={() => setActiveTab('token')} className="underline hover:text-zinc-600 dark:hover:text-slate-300">Backup Token</button> tab to encrypt archives.
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
                  <FolderPicker selectedIDs={tertiaryFolderIDs} onChange={ids => {
                    setTertiaryFolderIDs(ids)
                    saveAutoConfigMutation.mutate({
                      enabled: autoConfig?.enabled ?? false,
                      interval_hours: autoConfig?.interval_hours ?? 24,
                      retention_days: autoConfig?.retention_days ?? 30,
                      folder_ids: ids,
                    })
                  }} />

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

            {/* ── Auto backup schedule ───────────────────────────────────── */}
            {config?.tertiary_enabled && (
              <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <Clock size={16} className="text-brand-500" />
                  <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">Automatic backup</h2>
                </div>
                <p className="text-sm text-zinc-500 dark:text-slate-400">
                  Schedule automatic backups to server storage. Uses the same folders selected above.
                  A new archive is only created when your files have changed.
                </p>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-700 dark:text-slate-300">Enable auto backup</span>
                    <button
                      type="button"
                      onClick={() => saveAutoConfigMutation.mutate({
                        enabled: !(autoConfig?.enabled ?? false),
                        interval_hours: autoConfig?.interval_hours ?? 24,
                        retention_days: autoConfig?.retention_days ?? 30,
                        folder_ids: tertiaryFolderIDs,
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
                        retention_days: autoConfig?.retention_days ?? 30,
                        folder_ids: tertiaryFolderIDs,
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

                  <div className="flex items-center gap-3">
                    <label className="text-xs text-zinc-500 dark:text-slate-400 shrink-0">Keep backups</label>
                    <select
                      value={autoConfig?.retention_days ?? 30}
                      onChange={e => saveAutoConfigMutation.mutate({
                        enabled: autoConfig?.enabled ?? false,
                        interval_hours: autoConfig?.interval_hours ?? 24,
                        retention_days: Number(e.target.value),
                        folder_ids: tertiaryFolderIDs,
                      })}
                      className="text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] px-3 py-1.5 text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500 [&>option]:bg-white [&>option]:dark:bg-[#1a1d27] [&>option]:text-zinc-900 [&>option]:dark:text-slate-100"
                    >
                      <option value={7}>7 days</option>
                      <option value={14}>14 days</option>
                      <option value={30}>30 days</option>
                      <option value={60}>60 days</option>
                      <option value={90}>90 days</option>
                      <option value={180}>180 days</option>
                      <option value={365}>1 year</option>
                    </select>
                  </div>

                  {autoConfig?.last_run_at && (
                    <p className="text-xs text-zinc-400">
                      Last auto-backup: {new Date(autoConfig.last_run_at).toLocaleString()}
                    </p>
                  )}
                </div>
              </section>
            )}

            {/* ── Export (download) ─────────────────────────────────────── */}
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

            {/* ── Restore ──────────────────────────────────────────────── */}
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
      )}

      {/* ── Tab 2: Buddy Backup ─────────────────────────────────────────── */}
      {activeTab === 'buddy' && (
        !hasToken ? (
          <div className="rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 px-6 py-8 text-center space-y-3">
            <ShieldCheck size={32} className="mx-auto text-amber-500" />
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Backup token required</p>
            <p className="text-xs text-amber-600 dark:text-amber-500">
              Go to the <button type="button" onClick={() => setActiveTab('token')} className="underline font-medium">Backup Token</button> tab to generate your encryption token before using buddy backup.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {/* ── Storage balance overview ─────────────────────────────── */}
            <div className="grid grid-cols-2 gap-3">
              {/* What I store for buddy */}
              <div className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-4 space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-slate-400">
                  <ArrowDownToLine size={13} className="text-brand-500" />
                  You store for buddy
                </div>
                {buddyConfig?.has_receive_token && buddyReceived && buddyReceived.length > 0 ? (
                  <>
                    <p className="text-lg font-semibold text-zinc-900 dark:text-slate-100">
                      {formatBytes(buddyReceived.reduce((s, a) => s + a.size_bytes, 0))}
                    </p>
                    <p className="text-xs text-zinc-400">{buddyReceived.length} archive{buddyReceived.length !== 1 ? 's' : ''}</p>
                  </>
                ) : (
                  <p className="text-sm text-zinc-400 dark:text-slate-500">No archives received</p>
                )}
              </div>

              {/* What I have pushed to buddy */}
              <div className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-4 space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-slate-400">
                  <ArrowUpToLine size={13} className="text-brand-500" />
                  Buddy stores for you
                </div>
                {buddyConfig?.peer_configured && buddyConfig.last_push_at ? (
                  <>
                    <p className="text-lg font-semibold text-zinc-900 dark:text-slate-100">
                      {formatBytes(buddyConfig.last_push_bytes ?? 0)}
                    </p>
                    <p className="text-xs text-zinc-400">
                      Last push {new Date(buddyConfig.last_push_at).toLocaleDateString()}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-zinc-400 dark:text-slate-500">Not pushed yet</p>
                )}
              </div>
            </div>
            <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-5">
              <div className="flex items-center gap-2">
                <Server size={16} className="text-brand-500" />
                <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">Buddy backup</h2>
              </div>
              <p className="text-sm text-zinc-500 dark:text-slate-400">
                Push encrypted archives to a peer Sharedrive server for off-site redundancy.
                Exchange your receive info with a trusted friend — they configure your details on their side, you configure theirs on yours.
              </p>

              {/* ── Your receive info ───────────────────────────────────── */}
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

              {/* ── Push to peer ────────────────────────────────────────── */}
              <div className="space-y-3 border-t border-zinc-100 dark:border-[#2d3148] pt-4">
                <p className="text-xs font-semibold text-zinc-700 dark:text-slate-300">Push to peer</p>
                <p className="text-xs text-zinc-500 dark:text-slate-400">Enter the receive info your buddy gave you.</p>

                {/* Token explanation box */}
                <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900/50 px-3 py-2.5 space-y-0.5">
                  <p className="text-xs font-medium text-blue-700 dark:text-blue-400">Hvad er "Backup token"?</p>
                  <p className="text-xs text-blue-600 dark:text-blue-500">
                    Det er din <strong>personlige krypteringsnøgle</strong> fra fanen "Backup Token" — ikke det token du tastede ved opsætning af peer-forbindelsen.
                    Det peer-token du tastede tidligere er gemt og bruges automatisk til at autentificere. Din backup-nøgle bruges til at kryptere selve arkivet.
                  </p>
                </div>

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

                    {/* When token is available, show a single prominent push button */}
                    {buddyToken.trim() ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-500">
                          <Check size={12} />
                          Krypteringsnøgle klar — klikker du "Push backup now" krypteres og sendes arkivet til din buddy
                        </div>
                        <button
                          onClick={handleBuddyPush}
                          disabled={buddyPushing || buddyConfig?.push_in_progress}
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
                        >
                          {(buddyPushing || buddyConfig?.push_in_progress)
                            ? <><RefreshCw size={15} className="animate-spin" /> Pushing to buddy…</>
                            : <><ArrowUpToLine size={15} /> Push backup now</>}
                        </button>
                        {buddyConfig?.last_push_error && (
                          <p className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
                            <AlertTriangle size={12} /> {buddyConfig.last_push_error}
                          </p>
                        )}
                        <FolderPicker selectedIDs={buddyFolderIDs} onChange={setBuddyFolderIDs} />
                        <button
                          type="button"
                          onClick={() => setBuddyToken('')}
                          className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300 transition-colors"
                        >
                          Brug en anden nøgle
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={buddyToken}
                            onChange={e => { setBuddyToken(e.target.value); saveToken(e.target.value) }}
                            placeholder="Din backup-krypteringsnøgle (fra Backup Token fanen)"
                            className="flex-1 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                          <button
                            onClick={handleBuddyPush}
                            disabled={!buddyToken.trim() || buddyPushing || buddyConfig?.push_in_progress}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
                          >
                            {(buddyPushing || buddyConfig?.push_in_progress)
                              ? <><RefreshCw size={14} className="animate-spin" /> Pushing…</>
                              : <><ArrowUpToLine size={14} /> Push</>}
                          </button>
                        </div>
                        {buddyConfig?.last_push_error && (
                          <p className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
                            <AlertTriangle size={12} /> {buddyConfig.last_push_error}
                          </p>
                        )}
                        <p className="text-xs text-zinc-400">Find din nøgle under <button type="button" onClick={() => setActiveTab('token')} className="underline hover:text-zinc-600 dark:hover:text-slate-300">Backup Token</button> fanen.</p>
                        <FolderPicker selectedIDs={buddyFolderIDs} onChange={setBuddyFolderIDs} />
                      </div>
                    )}
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

            {/* ── Auto buddy push ──────────────────────────────────────── */}
            {buddyConfig?.peer_configured && (
              <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <Clock size={16} className="text-brand-500" />
                  <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">Automatisk buddy push</h2>
                </div>
                <p className="text-sm text-zinc-500 dark:text-slate-400">
                  Push automatisk til din buddy på et fast interval — eller straks når dine filer ændres.
                  Kræver at du har genereret en backup-nøgle (bruges til kryptering).
                </p>
                <div className="space-y-3">
                  {/* Enable toggle */}
                  <label className="flex items-center gap-3 cursor-pointer">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={buddyConfig?.auto_push_enabled ?? false}
                      onClick={() => {
                        const next = !(buddyConfig?.auto_push_enabled ?? false)
                        api.put('/api/v1/backup/buddy/auto', {
                          enabled: next,
                          interval_hours: buddyConfig?.auto_push_interval_hours ?? 24,
                          on_change: buddyConfig?.auto_push_on_change ?? false,
                          folder_ids: buddyConfig?.auto_push_folder_ids ?? [],
                        }).then(() => void refetchBuddyConfig()).catch(() => toast.error('Kunne ikke gemme'))
                      }}
                      className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1"
                      style={{ backgroundColor: buddyConfig?.auto_push_enabled ? 'var(--color-brand-600, #6366f1)' : '#d1d5db' }}
                    >
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${buddyConfig?.auto_push_enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
                    <span className="text-sm text-zinc-700 dark:text-slate-300">
                      {buddyConfig?.auto_push_enabled ? 'Aktiveret' : 'Deaktiveret'}
                    </span>
                  </label>

                  {buddyConfig?.auto_push_enabled && (
                    <div className="space-y-3 pl-2 border-l-2 border-brand-200 dark:border-brand-800">
                      {/* On-change toggle */}
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={buddyConfig?.auto_push_on_change ?? false}
                          onChange={e => {
                            api.put('/api/v1/backup/buddy/auto', {
                              enabled: true,
                              interval_hours: buddyConfig?.auto_push_interval_hours ?? 24,
                              on_change: e.target.checked,
                              folder_ids: buddyConfig?.auto_push_folder_ids ?? [],
                            }).then(() => void refetchBuddyConfig()).catch(() => toast.error('Kunne ikke gemme'))
                          }}
                          className="h-4 w-4 rounded border-zinc-300 text-brand-600 focus:ring-brand-500"
                        />
                        <div>
                          <p className="text-sm text-zinc-700 dark:text-slate-300">Push ved filændringer</p>
                          <p className="text-xs text-zinc-400 dark:text-slate-500">Pusher automatisk inden for ~15 min efter at du har ændret filer (uanset interval)</p>
                        </div>
                      </label>

                      {/* Interval selector */}
                      {!buddyConfig?.auto_push_on_change && (
                        <div className="flex items-center gap-3">
                          <label className="text-xs text-zinc-500 dark:text-slate-400 shrink-0">Interval</label>
                          <select
                            value={buddyConfig?.auto_push_interval_hours ?? 24}
                            onChange={e => {
                              api.put('/api/v1/backup/buddy/auto', {
                                enabled: true,
                                interval_hours: Number(e.target.value),
                                on_change: false,
                                folder_ids: buddyConfig?.auto_push_folder_ids ?? [],
                              }).then(() => void refetchBuddyConfig()).catch(() => toast.error('Kunne ikke gemme'))
                            }}
                            className="text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-2 py-1 text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
                          >
                            <option value={1}>Hver time</option>
                            <option value={6}>Hver 6. time</option>
                            <option value={12}>Hver 12. time</option>
                            <option value={24}>Dagligt</option>
                            <option value={48}>Hver 2. dag</option>
                            <option value={168}>Ugentligt</option>
                          </select>
                        </div>
                      )}

                      {/* Folder picker */}
                      <div>
                        <p className="text-xs text-zinc-500 dark:text-slate-400 mb-1">Mapper (tom = alle filer)</p>
                        <FolderPicker
                          selectedIDs={buddyConfig?.auto_push_folder_ids ?? []}
                          onChange={ids => {
                            api.put('/api/v1/backup/buddy/auto', {
                              enabled: true,
                              interval_hours: buddyConfig?.auto_push_interval_hours ?? 24,
                              on_change: buddyConfig?.auto_push_on_change ?? false,
                              folder_ids: ids,
                            }).then(() => void refetchBuddyConfig()).catch(() => toast.error('Kunne ikke gemme'))
                          }}
                        />
                      </div>

                      {/* Last run */}
                      {buddyConfig?.auto_push_last_run_at && (
                        <p className="text-xs text-zinc-400 dark:text-slate-500 flex items-center gap-1">
                          <Clock size={11} /> Sidst kørt {new Date(buddyConfig.auto_push_last_run_at).toLocaleString()}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* ── Received buddy archives ──────────────────────────────── */}
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
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-slate-400 pb-1 border-b border-zinc-100 dark:border-[#2d3148]">
                    <span>{buddyReceived.length} archive{buddyReceived.length !== 1 ? 's' : ''}</span>
                    <span className="font-medium">{formatBytes(buddyReceived.reduce((s, a) => s + a.size_bytes, 0))} total</span>
                  </div>
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
                </div>
              ) : (
                <p className="text-xs text-zinc-400">No archives received yet.</p>
              )}
            </section>
          </div>
        )
      )}

      {/* ── Tab 3: Backup Token ─────────────────────────────────────────── */}
      {activeTab === 'token' && (
        <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-brand-500" />
            <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">Backup token</h2>
          </div>
          <p className="text-sm text-zinc-500 dark:text-slate-400">
            This token is used to encrypt and decrypt all backup archives. It is required before you can use Server Storage or Buddy Backup.
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
      )}
    </div>
  )
}
