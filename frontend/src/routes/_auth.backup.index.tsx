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
  BuddyTunnelStatus,
  GeneratedBuddyReceiveToken,
  AutoBackupConfig,
} from '@/types/api'
import type { FileItem } from '@/types/api'
import {
  Archive,
  Bell,
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
  Network,
} from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'

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
  nearestSelectedAncestorID,
}: {
  item: FileItem
  depth: number
  selectedIDs: string[]
  onToggle: (id: string, nearestAncestorID?: string) => void
  ancestorIDs: Set<string>
  allChecked: boolean
  nearestSelectedAncestorID?: string
}) {
  const { t } = useI18n()
  const isAncestor = ancestorIDs.has(item.id)
  // isExplicit: this item is directly in selectedIDs (or allChecked covers everything)
  const isExplicit = allChecked || selectedIDs.includes(item.id)
  // inheritedSelected: an ancestor is explicitly selected, so this item is included implicitly
  const inheritedSelected = !isExplicit && !!nearestSelectedAncestorID
  const isChecked = isExplicit || inheritedSelected
  const isIndeterminate = !isChecked && isAncestor
  // Auto-expand when a descendant is selected or allChecked
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

  // When this item is explicitly selected, its children inherit from it.
  // Otherwise propagate the ancestor's ID downward.
  const ancestorIDForChildren = isExplicit ? item.id : nearestSelectedAncestorID

  return (
    <div>
      <div
        className={`flex items-center gap-1 py-1 rounded-md px-1 transition-colors ${
          isChecked
            ? 'bg-brand-50 dark:bg-brand-900/20'
            : isIndeterminate
            ? 'bg-brand-50/40 dark:bg-brand-900/10'
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
            isExplicit
              ? 'bg-brand-600 border-brand-600'
              : inheritedSelected
              ? 'bg-brand-400 border-brand-400'
              : isIndeterminate
              ? 'bg-brand-400/30 border-brand-400'
              : 'border-zinc-300 dark:border-[#4a5070] bg-white dark:bg-[#1a1d27]'
          }`}>
            {isChecked && (
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            {isIndeterminate && (
              <svg width="8" height="2" viewBox="0 0 8 2" fill="none">
                <path d="M1 1H7" stroke="white" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            )}
          </span>
          <input
            type="checkbox"
            checked={isChecked}
            onChange={() => onToggle(item.id, inheritedSelected ? nearestSelectedAncestorID : undefined)}
            className="sr-only"
          />
          {item.is_folder
            ? <Folder size={12} className={isChecked || isIndeterminate ? 'text-brand-500 shrink-0' : 'text-zinc-400 shrink-0'} />
            : <FileIcon size={12} className={isChecked ? 'text-brand-400 shrink-0' : 'text-zinc-400 shrink-0'} />}
          <span className={`text-xs truncate ${isChecked ? 'text-brand-700 dark:text-brand-300 font-medium' : isIndeterminate ? 'text-brand-600/70 dark:text-brand-400/70' : 'text-zinc-700 dark:text-slate-300'}`}>
            {item.name}
          </span>
        </label>
      </div>
      {expanded && item.is_folder && (
        loadingChildren
          ? <p className="text-xs text-zinc-400 py-0.5" style={{ paddingLeft: `${(depth + 1) * 14 + 20}px` }}>{t('backup.pickerLoading')}</p>
          : (children ?? []).map(c => (
              <FileTreeNode key={c.id} item={c} depth={depth + 1} selectedIDs={selectedIDs} onToggle={onToggle} ancestorIDs={ancestorIDs} allChecked={allChecked} nearestSelectedAncestorID={ancestorIDForChildren} />
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
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  // manualMode=true means the user has explicitly unchecked "All files"
  // and is choosing specific items. Without this flag, selectedIDs=[] is
  // ambiguous between "all files" and "nothing selected yet".
  const [manualMode, setManualMode] = useState(false)

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

  const qc = useQueryClient()
  const resolvedAncestors = ancestorIDs ?? new Set<string>()
  const items = rootItems ?? []
  // allChecked = true when in "all files" mode (no explicit selection)
  const allChecked = selectedIDs.length === 0 && !manualMode

  const handleAllFilesToggle = () => {
    if (allChecked) {
      // Uncheck "All files" → enter manual mode with nothing selected
      setManualMode(true)
    } else {
      // Check "All files" → clear manual selection and go back to all-mode
      setManualMode(false)
      onChange([])
    }
  }

  const toggle = (id: string, nearestAncestorID?: string) => {
    if (nearestAncestorID) {
      // User clicked on an item that is included via a selected ancestor.
      // Split the ancestor: replace it with all its loaded children except
      // the clicked item so the user can exclude that specific subfolder.
      const ancestorChildren = qc.getQueryData<FileItem[]>(['files', nearestAncestorID, 'picker-children']) ?? []
      const siblingIDs = ancestorChildren.map(c => c.id).filter(cid => cid !== id)
      setManualMode(true)
      onChange([...selectedIDs.filter(x => x !== nearestAncestorID), ...siblingIDs])
    } else if (allChecked) {
      // Clicked an item while in all-files mode → enter manual mode with only that item
      setManualMode(true)
      onChange([id])
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
        {allChecked ? t('backup.allFiles') : manualMode && selectedIDs.length === 0 ? t('backup.nothingSelected') : t('backup.nItemsSelected', { count: selectedIDs.length })}
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
              onChange={handleAllFilesToggle}
              className="sr-only"
            />
            <span className={`text-xs font-semibold ${allChecked ? 'text-brand-700 dark:text-brand-300' : 'text-zinc-700 dark:text-slate-300'}`}>
              {t('backup.allFiles')}
            </span>
          </label>
          {pickerLoading && (
            <p className="text-xs text-zinc-400 pt-1">{t('backup.pickerLoading')}</p>
          )}
          {!pickerLoading && items.length > 0 && (
            <div className="border-t border-zinc-200 dark:border-[#2d3148] pt-1.5 max-h-72 overflow-y-auto">
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
            <p className="text-xs text-zinc-400 pt-1">{t('backup.noFilesYet')}</p>
          )}
        </div>
      )}
    </div>
  )
}


// ── PushProgressBar ──────────────────────────────────────────────────────────────
function PushProgressBar({ progress }: { progress: { total_bytes: number; sent_bytes: number; started_at: string; active: boolean } }) {
  const { t } = useI18n()
  const pct = progress.total_bytes > 0 ? Math.min(100, Math.round((progress.sent_bytes / progress.total_bytes) * 100)) : 0
  const elapsedSec = (Date.now() - new Date(progress.started_at).getTime()) / 1000
  const speedBps = elapsedSec > 1 ? progress.sent_bytes / elapsedSec : 0
  const remaining = speedBps > 0 && progress.total_bytes > progress.sent_bytes
    ? Math.round((progress.total_bytes - progress.sent_bytes) / speedBps)
    : null
  const fmtBytes = (b: number) => b >= 1_048_576 ? (b / 1_048_576).toFixed(1) + " MB" : (b / 1024).toFixed(0) + " KB"
  const fmtTime = (s: number) => s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s"

  return (
    <div className="space-y-1">
      <div className="w-full bg-zinc-200 dark:bg-[#2d3148] rounded-full h-1.5">
        <div
          className="bg-brand-500 h-1.5 rounded-full transition-all duration-500"
          style={{ width: pct + "%" }}
        />
      </div>
      <div className="flex justify-between text-xs text-zinc-500 dark:text-slate-400">
        <span>{fmtBytes(progress.sent_bytes)} / {fmtBytes(progress.total_bytes)} ({pct}%)</span>
        <span>{speedBps > 0 ? fmtBytes(speedBps) + "/s" : ""}{remaining !== null ? " · " + t("backup.pushETA") + " " + fmtTime(remaining) : ""}</span>
      </div>
    </div>
  )
}

// ── main page ─────────────────────────────────────────────────────────────────

function BackupPage() {
  const qc = useQueryClient()
  const { t } = useI18n()

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
  const [buddyPushing, setBuddyPushing] = useState(false)
  const [pushStartedAt, setPushStartedAt] = useState<number | null>(null)

  // tab state
  const [activeTab, setActiveTab] = useState<'storage' | 'buddy' | 'token'>('storage')

  // buddy config state
  const [newReceiveToken, setNewReceiveToken] = useState<string | null>(null)
  const [receiveTokenCopied, setReceiveTokenCopied] = useState(false)
  const [peerURLInput, setPeerURLInput] = useState('')
  const [quotaGB, setQuotaGB] = useState<string>('')

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
    refetchInterval: (query) => (query.state.data?.push_in_progress ? 3000 : false),
  })

  const isPushing = buddyPushing || !!buddyConfig?.push_in_progress

  interface PushProgress { total_bytes: number; sent_bytes: number; started_at: string; active: boolean }
  const { data: pushProgress } = useQuery({
    queryKey: ['backup', 'push-progress'],
    queryFn: ({ signal }) => api.get<PushProgress>('/api/v1/backup/buddy/push/progress', signal),
    enabled: isPushing,
    refetchInterval: isPushing ? 1000 : false,
  })

  const { data: tunnelStatus, refetch: refetchTunnelStatus } = useQuery({
    queryKey: ['backup', 'tunnel-status'],
    queryFn: ({ signal }) => api.get<BuddyTunnelStatus>('/api/v1/backup/buddy/tunnel/status', signal),
    enabled: buddyConfig?.peer_configured ?? false,
    refetchInterval: 10_000, // poll every 10s to reflect tunnel state changes
  })

  const { data: pushedArchives, refetch: refetchPushedArchives } = useQuery({
    queryKey: ['backup', 'buddy-pushed'],
    queryFn: ({ signal }) => api.get<BuddyArchive[]>('/api/v1/backup/buddy/pushed', signal),
    enabled: buddyConfig?.peer_configured ?? false,
    staleTime: 30_000,
  })

  const { data: buddyReceived, refetch: refetchBuddyReceived } = useQuery({
    queryKey: ['backup', 'buddy-received'],
    queryFn: ({ signal }) => api.get<BuddyArchive[]>('/api/v1/backup/buddy/received', signal),
    enabled: buddyConfig?.has_receive_token ?? false,
  })

  // Sync quotaGB input when buddyConfig loads
  useEffect(() => {
    if (buddyConfig?.receive_quota_bytes != null) {
      setQuotaGB(String(Math.round(buddyConfig.receive_quota_bytes / 1073741824)))
    }
  }, [buddyConfig?.receive_quota_bytes])

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
    onError: () => toast.error(t('backup.tokenPasswordFailed')),
  })

  const revokeMutation = useMutation({
    mutationFn: () => api.delete('/api/v1/backup/password'),
    onSuccess: () => {
      setNewToken(null)
      void qc.invalidateQueries({ queryKey: ['backup', 'password'] })
      toast.success(t('backup.tokenRevoked'))
    },
    onError: () => toast.error(t('backup.tokenRevokeFailed')),
  })

  const deleteTertiaryMutation = useMutation({
    mutationFn: (filename: string) => api.delete(`/api/v1/backup/tertiary/${encodeURIComponent(filename)}`),
    onSuccess: () => { void refetchTertiary(); toast.success(t('backup.archiveDeleted')) },
    onError: () => toast.error(t('backup.archiveDeleteFailed')),
  })

  const deleteBuddyMutation = useMutation({
    mutationFn: (filename: string) => api.delete(`/api/v1/backup/buddy/received/${encodeURIComponent(filename)}`),
    onSuccess: () => { void refetchBuddyReceived(); toast.success(t('backup.archiveDeleted')) },
    onError: () => toast.error(t('backup.archiveDeleteFailed')),
  })

  const setQuotaMutation = useMutation({
    mutationFn: (bytes: number | null) => api.put('/api/v1/backup/buddy/quota', { quota_bytes: bytes }),
  })

  const saveAutoConfigMutation = useMutation({
    mutationFn: (body: { enabled: boolean; interval_hours: number; retention_days: number; folder_ids: string[] }) =>
      api.put('/api/v1/backup/auto', body),
    onSuccess: () => { void refetchAutoConfig(); toast.success(t('backup.autoSaved')) },
    onError: () => toast.error(t('backup.autoSaveFailed')),
  })

  const generateReceiveTokenMutation = useMutation({
    mutationFn: () => api.post<GeneratedBuddyReceiveToken>('/api/v1/backup/buddy/receive-token', {}),
    onSuccess: (data) => {
      setNewReceiveToken(data.token)
      setReceiveTokenCopied(false)
      void refetchBuddyConfig()
    },
    onError: () => toast.error(t('backup.receiveTokenGenFailed')),
  })

  const revokeReceiveTokenMutation = useMutation({
    mutationFn: () => api.delete('/api/v1/backup/buddy/receive-token'),
    onSuccess: () => {
      setNewReceiveToken(null)
      void refetchBuddyConfig()
      toast.success(t('backup.receiveTokenRevoked'))
    },
    onError: () => toast.error(t('backup.receiveTokenRevokeFailed')),
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
      toast.success(t('backup.peerSaved'))
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
      toast.success(t('backup.peerCleared'))
    },
    onError: () => toast.error(t('backup.peerClearFailed')),
  })

  const tunnelConnectMutation = useMutation({
    mutationFn: () => api.post('/api/v1/backup/buddy/tunnel/connect', {}),
    onSuccess: () => { void refetchTunnelStatus(); toast.success(t('backup.tunnelConnected')) },
    onError: (e: unknown) => toast.error((e as Error).message ?? t('backup.tunnelConnectFailed')),
  })

  const tunnelDisconnectMutation = useMutation({
    mutationFn: () => api.delete('/api/v1/backup/buddy/tunnel/connect'),
    onSuccess: () => { void refetchTunnelStatus(); toast.success(t('backup.tunnelDisconnected')) },
    onError: () => toast.error(t('backup.tunnelDisconnectFailed')),
  })

  const deletePushedMutation = useMutation({
    mutationFn: (filename: string) => api.delete(`/api/v1/backup/buddy/pushed/${encodeURIComponent(filename)}`),
    onSuccess: () => { void refetchPushedArchives(); toast.success(t('backup.peerArchiveDeleted')) },
    onError: () => toast.error(t('backup.peerArchiveDeleteFailed')),
  })

  // ── handlers ──────────────────────────────────────────────────────────────

  const handleCopyToken = async () => {
    if (!newToken) return
    await navigator.clipboard.writeText(newToken)
    setTokenCopied(true)
    setTimeout(() => setTokenCopied(false), 2500)
  }

  const handleExport = async () => {
    if (!exportToken.trim()) { toast.error(t('backup.enterTokenFirst')); return }
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
      toast.success(t('backup.downloaded'))
    } catch { toast.error(t('backup.exportFailed')) }
  }

  const handleRestore = async () => {
    if (!restoreToken.trim()) { toast.error(t('backup.enterToken')); return }
    if (!restoreFile) { toast.error(t('backup.selectFile')); return }
    const form = new FormData()
    form.append('token', restoreToken.trim())
    form.append('file', restoreFile)
    try {
      const response = await fetch('/api/v1/backup/restore', {
        method: 'POST', credentials: 'include', body: form,
      })
      const data = await response.json() as RestoreResult | { error: string }
      if (!response.ok) { toast.error((data as { error: string }).error ?? t('backup.restoreFailed')); return }
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
    } catch { toast.error(t('backup.restoreFailed')) }
  }

  const handleStoreTertiary = async () => {
    if (!tertiaryToken.trim()) { toast.error('Enter your backup token'); return }
    setTertiarySaving(true)
    try {
      await api.post('/api/v1/backup/tertiary', {
        token: tertiaryToken.trim(),
        ...(tertiaryFolderIDs.length > 0 && { folder_ids: tertiaryFolderIDs }),
      })
      toast.success(t('backup.archiveSaved'))
      void refetchTertiary()
    } catch (e: unknown) {
      toast.error((e as Error).message ?? t('backup.archiveSaveFailed'))
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
    if (!buddyToken.trim()) { toast.error(t('backup.enterTokenFirst')); return }
    if (!status?.has_password) { toast.error(t('backup.generateTokenFirst')); return }
    setBuddyPushing(true)
    try {
      await api.post('/api/v1/backup/buddy/push', {
        token: buddyToken.trim(),
        ...(( buddyConfig?.auto_push_folder_ids?.length ?? 0) > 0 && { folder_ids: buddyConfig!.auto_push_folder_ids }),
      })
      toast.success(t('backup.pushStarted'))
      // Refetch immediately so polling picks up push_in_progress = true.
      void refetchBuddyConfig()
      // Also do a short-delay refetch to catch fast failures (e.g. peer 503).
      // If the goroutine fails in < 1s the regular refetch interval never fires.
      setTimeout(() => {
        refetchBuddyConfig().then(result => {
          if (!result.data?.push_in_progress && result.data?.last_push_error) {
            toast.error(t('backup.pushFailed') + ': ' + result.data.last_push_error)
          } else if (!result.data?.push_in_progress) {
            // Push succeeded — refresh the list of archives stored at peer
            void refetchPushedArchives()
          }
        }).catch(() => {})
      }, 1500)
    } catch (e: unknown) {
      // 403 means the backup token is wrong (stale sessionStorage).
      // Clear it so the input field reappears and the user can re-enter.
      if ((e as { status?: number }).status === 403) {
        setBuddyToken('')
        sessionStorage.removeItem('sharedrive_backup_token')
        toast.error(t('backup.wrongToken'))
      } else {
        toast.error((e as Error).message ?? t('backup.pushFailed'))
      }
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
          {t('backup.title')}
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-slate-400">
          {t('backup.description')}
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
          <HardDrive size={14} /> {t('backup.tabStorage')}
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
          <Server size={14} /> {t('backup.tabBuddy')}
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
          <ShieldCheck size={14} /> {t('backup.tabToken')}
        </button>
      </div>

      {/* ── Tab 1: Server Storage ───────────────────────────────────────── */}
      {activeTab === 'storage' && (
        !hasToken ? (
          <div className="rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 px-6 py-8 text-center space-y-3">
            <ShieldCheck size={32} className="mx-auto text-amber-500" />
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">{t('backup.tokenRequired')}</p>
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {t('backup.tokenRequiredDesc')}
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {/* ── Tertiary — server storage ──────────────────────────────── */}
            <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
              <div className="flex items-center gap-2">
                <HardDrive size={16} className="text-brand-500" />
                <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{t('backup.storageTitle')}</h2>
              </div>
              <p className="text-sm text-zinc-500 dark:text-slate-400">
                {t('backup.storageDesc')}
              </p>
              <p className="text-xs text-zinc-400 dark:text-slate-500">
                {t('backup.tabToken')}
              </p>

              {config?.tertiary_enabled && config.disk_total_bytes != null && config.disk_total_bytes > 0 && (
                <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-slate-400">
                  <HardDrive size={12} />
                  <span>
                    {t('backup.diskFree', { free: formatBytes(config.disk_free_bytes ?? 0), total: formatBytes(config.disk_total_bytes) })}
                  </span>
                </div>
              )}

              {!config?.tertiary_enabled ? (
                <div className="rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-4 py-3 text-xs text-zinc-500 dark:text-slate-400 space-y-1">
                  <p className="font-medium text-zinc-700 dark:text-slate-300">{t('backup.notConfigured')}</p>
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
                      <p className="text-xs font-medium text-zinc-500 dark:text-slate-400">{t('backup.storedArchives')}</p>
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
                    <p className="text-xs text-zinc-400">{t('backup.noArchives')}</p>
                  )}
                </>
              )}
            </section>

            {/* ── Auto backup schedule ───────────────────────────────────── */}
            {config?.tertiary_enabled && (
              <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <Clock size={16} className="text-brand-500" />
                  <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{t('backup.autoTitle')}</h2>
                </div>
                <p className="text-sm text-zinc-500 dark:text-slate-400">
                  Schedule automatic backups to server storage. Uses the same folders selected above.
                  A new archive is only created when your files have changed.
                </p>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-700 dark:text-slate-300">{t('backup.enableAuto')}</span>
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
                    <label className="text-xs text-zinc-500 dark:text-slate-400 shrink-0">{t('backup.interval')}</label>
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
                      <option value={6}>{t('backup.every6h')}</option>
                      <option value={12}>{t('backup.every12h')}</option>
                      <option value={24}>{t('backup.every24h')}</option>
                      <option value={48}>{t('backup.every48h')}</option>
                      <option value={168}>{t('backup.weekly')}</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-3">
                    <label className="text-xs text-zinc-500 dark:text-slate-400 shrink-0">{t('backup.keepBackups')}</label>
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
                      <option value={7}>{t('backup.7days')}</option>
                      <option value={14}>{t('backup.14days')}</option>
                      <option value={30}>{t('backup.30days')}</option>
                      <option value={60}>{t('backup.60days')}</option>
                      <option value={90}>{t('backup.90days')}</option>
                      <option value={180}>{t('backup.180days')}</option>
                      <option value={365}>{t('backup.1year')}</option>
                    </select>
                  </div>

                  {autoConfig?.last_run_at && (
                    <p className="text-xs text-zinc-400">
                      {t('backup.lastAutoAt', { when: new Date(autoConfig.last_run_at).toLocaleString() })}
                    </p>
                  )}

                  {/* Tertiary failure banner */}
                  {autoConfig?.auto_failed_since && (
                    <div className="flex items-start gap-3 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 px-4 py-3 text-sm">
                      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-500" />
                      <div>
                        <p className="font-medium text-red-700 dark:text-red-400">{t('backup.autoFailing')}</p>
                        <p className="text-xs text-red-600 dark:text-red-500 mt-0.5">
                          {t('backup.failingSince', { when: new Date(autoConfig.auto_failed_since).toLocaleString() })}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* ── Email notifications ────────────────────────────────────── */}
            {config?.tertiary_enabled && (
              <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-3">
                <div className="flex items-center gap-2">
                  <Bell size={16} className="text-brand-500" />
                  <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{t('backup.notificationsTitle')}</h2>
                </div>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoConfig?.notify_on_failure ?? true}
                    onChange={e => {
                      api.put('/api/v1/backup/notify', { enabled: e.target.checked })
                        .then(() => { void refetchAutoConfig(); void refetchBuddyConfig() })
                        .catch(() => toast.error(t('backup.savingFailed')))
                    }}
                    className="h-4 w-4 rounded border-zinc-300 text-brand-600 focus:ring-brand-500"
                  />
                  <div>
                    <p className="text-sm text-zinc-700 dark:text-slate-300">{t('backup.notifyOnFailure')}</p>
                    <p className="text-xs text-zinc-400 dark:text-slate-500">{t('backup.notifyOnFailureDesc')}</p>
                  </div>
                </label>
              </section>
            )}

            {/* ── Export (download) ─────────────────────────────────────── */}
            <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Download size={16} className="text-brand-500" />
                <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{t('backup.exportTitle')}</h2>
              </div>
              <p className="text-sm text-zinc-500 dark:text-slate-400">
                Downloads an AES-256 encrypted archive (<code className="text-xs">.shdbak</code>) to your device.
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={exportToken}
                  onChange={e => { setExportToken(e.target.value); saveToken(e.target.value) }}
                  placeholder={t('backup.tokenPlaceholder')}
                  className="flex-1 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <button
                  onClick={handleExport}
                  disabled={!exportToken.trim()}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
                >
                  <Download size={14} /> {t('backup.download')}
                </button>
              </div>
              <FolderPicker selectedIDs={exportFolderIDs} onChange={setExportFolderIDs} />
            </section>

            {/* ── Restore ──────────────────────────────────────────────── */}
            <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Upload size={16} className="text-brand-500" />
                <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{t('backup.restoreTitle')}</h2>
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
                  placeholder={t('backup.tokenPlaceholder')}
                  className="w-full text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <div className="flex gap-2 items-center">
                  <label className="flex-1 flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg border border-dashed border-zinc-300 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors">
                    <Upload size={14} className="text-zinc-400" />
                    <span className="text-sm text-zinc-500 dark:text-slate-400 truncate">
                      {restoreFile ? restoreFile.name : t('backup.chooseFile')}
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
                    {t('backup.restore')}
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
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">{t('backup.tokenRequired')}</p>
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {t('backup.tokenRequiredDesc')}
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {/* ── Push failure warning banner ──────────────────────────── */}
            {buddyConfig?.push_failed_since && (
              <div className="rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 px-4 py-3 flex items-start gap-3">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-500" />
                <div className="space-y-0.5 flex-1">
                  <p className="text-sm font-medium text-red-700 dark:text-red-400">{t('backup.buddyPushFailing')}</p>
                  <p className="text-xs text-red-600 dark:text-red-400">
                    {t('backup.failingSince', { when: new Date(buddyConfig.push_failed_since).toLocaleString() })}
                  </p>
                  {buddyConfig.last_push_error && (
                    <p className="text-xs text-red-600 dark:text-red-400 font-mono mt-1 break-all">{buddyConfig.last_push_error}</p>
                  )}
                  {buddyConfig.last_push_error?.includes('413') && (
                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-1.5">{t('backup.hint413')}</p>
                  )}
                </div>
              </div>
            )}

            {/* ── Storage balance overview ─────────────────────────────── */}
            <div className={`grid gap-3 ${buddyConfig?.peer_configured ? 'grid-cols-3' : 'grid-cols-2'}`}>
              {/* What I store for buddy */}
              <div className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-4 space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-slate-400">
                  <ArrowDownToLine size={13} className="text-brand-500" />
                  {t('backup.youStoreForBuddy')}
                </div>
                {buddyConfig?.has_receive_token && buddyReceived && buddyReceived.length > 0 ? (
                  <>
                    <p className="text-lg font-semibold text-zinc-900 dark:text-slate-100">
                      {formatBytes(buddyReceived.reduce((s, a) => s + a.size_bytes, 0))}
                    </p>
                    <p className="text-xs text-zinc-400">{buddyReceived.length} {buddyReceived.length !== 1 ? t('backup.archives') : t('backup.archive')}</p>
                  </>
                ) : (
                  <p className="text-sm text-zinc-400 dark:text-slate-500">{t('backup.noReceived')}</p>
                )}
              </div>

              {/* What I have pushed to buddy */}
              <div className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-4 space-y-1">
                <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-slate-400">
                  <ArrowUpToLine size={13} className="text-brand-500" />
                  {t('backup.buddyStoresForYou')}
                </div>
                {buddyConfig?.peer_configured && (pushedArchives && pushedArchives.length > 0) ? (
                  <>
                    <p className="text-lg font-semibold text-zinc-900 dark:text-slate-100">
                      {formatBytes(pushedArchives.reduce((s, a) => s + a.size_bytes, 0))}
                    </p>
                    <p className="text-xs text-zinc-400">{pushedArchives.length} {pushedArchives.length !== 1 ? t('backup.archives') : t('backup.archive')}</p>
                  </>
                ) : buddyConfig?.peer_configured && buddyConfig.last_push_at ? (
                  <>
                    <p className="text-lg font-semibold text-zinc-900 dark:text-slate-100">
                      {formatBytes(buddyConfig.last_push_bytes ?? 0)}
                    </p>
                    <p className="text-xs text-zinc-400">
                      {t('backup.lastAutoAt', { when: new Date(buddyConfig.last_push_at).toLocaleDateString() })}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-zinc-400 dark:text-slate-500">{t('backup.noArchivesYet')}</p>
                )}
              </div>
              {/* Tunnel status card — only when peer is configured */}
              {buddyConfig?.peer_configured && (
                <div className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-4 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-slate-400">
                    <Network size={13} className="text-brand-500" />
                    Reverse tunnel
                  </div>
                  {tunnelStatus?.connected_to_peer ? (
                    <>
                      <p className="text-sm font-semibold text-green-600 dark:text-green-400 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
                        {t('backup.tunnelActive')}
                      </p>
                      {!tunnelStatus.peer_connected_here && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">{t('backup.tunnelWrongDirection')}</p>
                      )}
                      <button
                        onClick={() => tunnelDisconnectMutation.mutate()}
                        disabled={tunnelDisconnectMutation.isPending}
                        className="text-xs text-red-500 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                      >
                        {t('backup.tunnelDisconnect')}
                      </button>
                    </>
                  ) : tunnelStatus?.peer_connected_here ? (
                    <>
                      <p className="text-sm font-semibold text-blue-600 dark:text-blue-400 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
                        {t('backup.tunnelPeerConnected')}
                      </p>
                      <p className="text-xs text-zinc-400">{t('backup.tunnelPeerConnectedDesc')}</p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-zinc-400 dark:text-slate-500">{t('backup.tunnelInactive')}</p>
                      <button
                        onClick={() => tunnelConnectMutation.mutate()}
                        disabled={tunnelConnectMutation.isPending}
                        className="text-xs text-brand-600 dark:text-brand-400 hover:underline transition-colors flex items-center gap-1"
                      >
                        {tunnelConnectMutation.isPending && <RefreshCw size={10} className="animate-spin" />}
                        {t('backup.tunnelActivateCgnat')}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-5">
              <div className="flex items-center gap-2">
                <Server size={16} className="text-brand-500" />
                <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{t('backup.buddyTitle')}</h2>
              </div>
              <p className="text-sm text-zinc-500 dark:text-slate-400">
                {t('backup.buddyDesc')}
              </p>

              {/* ── Your receive info ───────────────────────────────────── */}
              <div className="space-y-3 border-t border-zinc-100 dark:border-[#2d3148] pt-4">
                <p className="text-xs font-semibold text-zinc-700 dark:text-slate-300">{t('backup.receiveInfo')}</p>
                <p className="text-xs text-zinc-500 dark:text-slate-400">{t('backup.receiveInfoDesc')}</p>

                {/* URL */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500 dark:text-slate-400 w-20 shrink-0">{t('backup.serverUrl')}</span>
                  <code className="flex-1 text-xs font-mono bg-zinc-50 dark:bg-[#0f1117] border border-zinc-200 dark:border-[#2d3148] rounded px-2 py-1 truncate">{window.location.origin}</code>
                  <button
                    onClick={() => { void navigator.clipboard.writeText(window.location.origin); toast.success(t('backup.urlCopied')) }}
                    className="shrink-0 p-1.5 rounded border border-zinc-200 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                    title={t('backup.copyUrl')}
                  >
                    <Copy size={12} />
                  </button>
                </div>

                {/* User ID */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500 dark:text-slate-400 w-20 shrink-0">{t('backup.yourUserId')}</span>
                  <code className="flex-1 text-xs font-mono bg-zinc-50 dark:bg-[#0f1117] border border-zinc-200 dark:border-[#2d3148] rounded px-2 py-1 truncate">{buddyConfig?.user_id ?? '…'}</code>
                  <button
                    onClick={() => { if (buddyConfig?.user_id) { void navigator.clipboard.writeText(buddyConfig.user_id); toast.success(t('backup.userIdCopied')) } }}
                    className="shrink-0 p-1.5 rounded border border-zinc-200 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                    title={t('backup.copyUserId')}
                  >
                    <Copy size={12} />
                  </button>
                </div>

                {/* Receive token */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500 dark:text-slate-400 w-20 shrink-0">{t('backup.receiveTokenLabel')}</span>
                  {buddyConfig?.has_receive_token ? (
                    <span className="flex-1 text-xs font-mono text-zinc-500 dark:text-slate-400">
                      {buddyConfig.receive_token_prefix}••••••••••••••••••••••••••••••••••••
                    </span>
                  ) : (
                    <span className="flex-1 text-xs text-zinc-400">{t('backup.notGeneratedYet')}</span>
                  )}
                  <button
                    onClick={() => generateReceiveTokenMutation.mutate()}
                    disabled={generateReceiveTokenMutation.isPending}
                    className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-zinc-200 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={10} /> {buddyConfig?.has_receive_token ? t('backup.rotate') : t('backup.generate')}
                  </button>
                  {buddyConfig?.has_receive_token && (
                    <button
                      onClick={() => { if (confirm(t('backup.revokeReceiveToken'))) revokeReceiveTokenMutation.mutate() }}
                      disabled={revokeReceiveTokenMutation.isPending}
                      className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                    >
                      <Trash2 size={10} /> {t('backup.revoke')}
                    </button>
                  )}
                </div>

                {newReceiveToken && (
                  <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-2">
                    <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <p className="text-xs font-medium">{t('backup.receiveTokenSaveNow')}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-xs font-mono bg-white dark:bg-[#0f1117] border border-amber-200 dark:border-amber-800 rounded px-3 py-2 break-all text-zinc-800 dark:text-slate-200 select-all">
                        {newReceiveToken}
                      </code>
                      <button
                        onClick={handleCopyReceiveToken}
                        className="shrink-0 p-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                        title={t('backup.copyReceiveToken')}
                      >
                        {receiveTokenCopied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                      </button>
                    </div>
                  </div>
                )}

                {/* ── Fair-trade quota ─────────────────────────────────── */}
                <div className="space-y-2 border-t border-zinc-100 dark:border-[#2d3148] pt-3">
                  <p className="text-xs font-semibold text-zinc-700 dark:text-slate-300">{t('backup.quotaTitle')}</p>
                  <p className="text-xs text-zinc-500 dark:text-slate-400">{t('backup.quotaDesc')}</p>

                  {/* Usage indicators */}
                  <div className="space-y-1.5">
                    <div className="space-y-0.5">
                      <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-slate-400">
                        <span>{t('backup.quotaUsage')}</span>
                        <span>
                          {formatBytes((buddyReceived ?? []).reduce((s, a) => s + a.size_bytes, 0))}
                          {buddyConfig?.receive_quota_bytes != null && ` / ${formatBytes(buddyConfig.receive_quota_bytes)}`}
                        </span>
                      </div>
                      {buddyConfig?.receive_quota_bytes != null && (
                        <div className="w-full bg-zinc-100 dark:bg-[#2d3148] rounded-full h-1.5">
                          <div
                            className="bg-brand-500 h-1.5 rounded-full transition-all"
                            style={{ width: `${Math.min(100, ((buddyReceived ?? []).reduce((s, a) => s + a.size_bytes, 0) / buddyConfig.receive_quota_bytes) * 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-slate-400">
                      <span>{t('backup.peerUsage')}</span>
                      <span>{formatBytes(buddyConfig?.peer_stored_bytes ?? 0)}</span>
                    </div>
                  </div>

                  {/* Quota input */}
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={quotaGB}
                      onChange={e => setQuotaGB(e.target.value)}
                      placeholder={t('backup.quotaUnlimited')}
                      className="w-28 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <span className="text-xs text-zinc-500">GB</span>
                    <button
                      onClick={() => {
                        const bytes = quotaGB.trim() ? Math.round(parseFloat(quotaGB) * 1073741824) : null
                        setQuotaMutation.mutate(bytes, {
                          onSuccess: () => { toast.success(t('backup.quotaSaved')); void refetchBuddyConfig() },
                          onError: () => toast.error(t('backup.quotaSaveFailed')),
                        })
                      }}
                      disabled={setQuotaMutation.isPending}
                      className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium disabled:opacity-50 transition-colors"
                    >
                      {t('backup.quotaSave')}
                    </button>
                  </div>
                  <p className="text-xs text-zinc-400 italic">{t('backup.fairTrade')}</p>
                </div>
              </div>

              {/* ── Push to peer ────────────────────────────────────────── */}
              <div className="space-y-3 border-t border-zinc-100 dark:border-[#2d3148] pt-4">
                <p className="text-xs font-semibold text-zinc-700 dark:text-slate-300">{t('backup.pushToPeer')}</p>
                <p className="text-xs text-zinc-500 dark:text-slate-400">{t('backup.pushToPeerDesc')}</p>

                {/* Token explanation box */}
                <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900/50 px-3 py-2.5 space-y-0.5">
                  <p className="text-xs font-medium text-blue-700 dark:text-blue-400">{t('backup.encKeyExplainTitle')}</p>
                  <p className="text-xs text-blue-600 dark:text-blue-500">
                    {t('backup.encKeyExplainDesc')}
                  </p>
                </div>

                {buddyConfig?.peer_configured ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 rounded-lg bg-zinc-50 dark:bg-[#0f1117] border border-zinc-200 dark:border-[#2d3148] px-3 py-2">
                      <span className="text-xs text-zinc-500 dark:text-slate-400">Peer:</span>
                      <span className="flex-1 text-xs font-mono text-zinc-700 dark:text-slate-300 truncate">{buddyConfig.peer_url}</span>
                      <button
                        onClick={() => { if (confirm(t('backup.clearPeerConfig'))) clearPeerConfigMutation.mutate() }}
                        disabled={clearPeerConfigMutation.isPending}
                        className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                      >
                        <Trash2 size={10} /> {t('backup.peerClear')}
                      </button>
                    </div>

                    {buddyToken.trim() ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-500">
                          <Check size={12} />
                          {t('backup.encKeyReady')}
                        </div>
                        <button
                          onClick={handleBuddyPush}
                          disabled={isPushing}
                          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
                        >
                          {(isPushing)
                            ? <><RefreshCw size={15} className="animate-spin" /> {t('backup.pushingNow')}</>
                            : <><ArrowUpToLine size={15} /> {t('backup.pushNow')}</>}
                        </button>
                        {isPushing && pushProgress && pushProgress.total_bytes > 0 && (
                          <PushProgressBar progress={pushProgress} />
                        )}
                        {buddyConfig?.push_in_progress && !buddyPushing && (
                          <button
                            onClick={async () => {
                              await api.delete('/api/v1/backup/buddy/push-in-progress')
                              void refetchBuddyConfig()
                            }}
                            className="w-full text-xs text-zinc-500 dark:text-slate-400 underline hover:text-zinc-700 dark:hover:text-slate-200"
                          >
                            {t('backup.resetStuckPush')}
                          </button>
                        )}
                        {buddyConfig?.last_push_error && (
                          <p className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
                            <AlertTriangle size={12} /> {buddyConfig.last_push_error}
                          </p>
                        )}
                        <FolderPicker
                          selectedIDs={buddyConfig?.auto_push_folder_ids ?? []}
                          onChange={ids => {
                            api.put('/api/v1/backup/buddy/auto', {
                              enabled: buddyConfig?.auto_push_enabled ?? false,
                              interval_hours: buddyConfig?.auto_push_interval_hours ?? 24,
                              on_change: buddyConfig?.auto_push_on_change ?? false,
                              folder_ids: ids,
                            }).then(() => void refetchBuddyConfig()).catch(() => toast.error(t('backup.savingFailed')))
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => setBuddyToken('')}
                          className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300 transition-colors"
                        >
                          {t('backup.useAnotherKey')}
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={buddyToken}
                            onChange={e => { setBuddyToken(e.target.value); saveToken(e.target.value) }}
                            placeholder={t('backup.encKeyPlaceholder')}
                            className="flex-1 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                          />
                          <button
                            onClick={handleBuddyPush}
                            disabled={!buddyToken.trim() || isPushing}
                            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
                          >
                            {(isPushing)
                              ? <><RefreshCw size={14} className="animate-spin" /> {t('backup.pushingNow')}</>
                              : <><ArrowUpToLine size={14} /> Push</>}
                          </button>
                        </div>
                        {buddyConfig?.last_push_error && (
                          <p className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
                            <AlertTriangle size={12} /> {buddyConfig.last_push_error}
                          </p>
                        )}
                        <p className="text-xs text-zinc-400">{t('backup.tabToken')}</p>
                        <FolderPicker
                          selectedIDs={buddyConfig?.auto_push_folder_ids ?? []}
                          onChange={ids => {
                            api.put('/api/v1/backup/buddy/auto', {
                              enabled: buddyConfig?.auto_push_enabled ?? false,
                              interval_hours: buddyConfig?.auto_push_interval_hours ?? 24,
                              on_change: buddyConfig?.auto_push_on_change ?? false,
                              folder_ids: ids,
                            }).then(() => void refetchBuddyConfig()).catch(() => toast.error(t('backup.savingFailed')))
                          }}
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="url"
                      value={peerURLInput}
                      onChange={e => setPeerURLInput(e.target.value)}
                      placeholder={t('backup.peerUrlPlaceholder')}
                      className="w-full text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <input
                      type="text"
                      value={peerUserIDInput}
                      onChange={e => setPeerUserIDInput(e.target.value)}
                      placeholder={t('backup.peerUserIdPlaceholder')}
                      className="w-full text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={peerTokenInput}
                        onChange={e => setPeerTokenInput(e.target.value)}
                        placeholder={t('backup.peerTokenPlaceholder')}
                        className="flex-1 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                      <button
                        onClick={() => savePeerConfigMutation.mutate()}
                        disabled={!peerURLInput.trim() || !peerUserIDInput.trim() || !peerTokenInput.trim() || savePeerConfigMutation.isPending}
                        className="shrink-0 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
                      >
                        {t('users.save')}
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
                  <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{t('backup.autoBuddyTitle')}</h2>
                </div>
                <p className="text-sm text-zinc-500 dark:text-slate-400">
                  {t('backup.autoBuddyDesc')}
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
                        }).then(() => void refetchBuddyConfig()).catch(() => toast.error(t('backup.savingFailed')))
                      }}
                      className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1"
                      style={{ backgroundColor: buddyConfig?.auto_push_enabled ? 'var(--color-brand-600, #6366f1)' : '#d1d5db' }}
                    >
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${buddyConfig?.auto_push_enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </button>
                    <span className="text-sm text-zinc-700 dark:text-slate-300">
                      {buddyConfig?.auto_push_enabled ? t('backup.enabled') : t('backup.disabled')}
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
                            }).then(() => void refetchBuddyConfig()).catch(() => toast.error(t('backup.savingFailed')))
                          }}
                          className="h-4 w-4 rounded border-zinc-300 text-brand-600 focus:ring-brand-500"
                        />
                        <div>
                          <p className="text-sm text-zinc-700 dark:text-slate-300">{t('backup.pushOnChange')}</p>
                          <p className="text-xs text-zinc-400 dark:text-slate-500">{t('backup.pushOnChangeDesc')}</p>
                        </div>
                      </label>

                      {/* Interval selector */}
                      {!buddyConfig?.auto_push_on_change && (
                        <div className="flex items-center gap-3">
                          <label className="text-xs text-zinc-500 dark:text-slate-400 shrink-0">{t('backup.interval')}</label>
                          <select
                            value={buddyConfig?.auto_push_interval_hours ?? 24}
                            onChange={e => {
                              api.put('/api/v1/backup/buddy/auto', {
                                enabled: true,
                                interval_hours: Number(e.target.value),
                                on_change: false,
                                folder_ids: buddyConfig?.auto_push_folder_ids ?? [],
                              }).then(() => void refetchBuddyConfig()).catch(() => toast.error(t('backup.savingFailed')))
                            }}
                            className="text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-2 py-1 text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
                          >
                            <option value={1}>{t('backup.everyHour')}</option>
                            <option value={6}>{t('backup.every6Hours')}</option>
                            <option value={12}>{t('backup.every12Hours')}</option>
                            <option value={24}>{t('backup.daily')}</option>
                            <option value={48}>{t('backup.every2Days')}</option>
                            <option value={168}>{t('backup.weekly')}</option>
                          </select>
                        </div>
                      )}

                      {/* Folder picker */}
                      <div>
                        <p className="text-xs text-zinc-500 dark:text-slate-400 mb-1">{t('backup.foldersLabel')}</p>
                        <FolderPicker
                          selectedIDs={buddyConfig?.auto_push_folder_ids ?? []}
                          onChange={ids => {
                            api.put('/api/v1/backup/buddy/auto', {
                              enabled: true,
                              interval_hours: buddyConfig?.auto_push_interval_hours ?? 24,
                              on_change: buddyConfig?.auto_push_on_change ?? false,
                              folder_ids: ids,
                            }).then(() => void refetchBuddyConfig()).catch(() => toast.error(t('backup.savingFailed')))
                          }}
                        />
                      </div>

                      {/* Last run */}
                      {buddyConfig?.auto_push_last_run_at && (
                        <p className="text-xs text-zinc-400 dark:text-slate-500 flex items-center gap-1">
                          <Clock size={11} /> {t('backup.lastAutoAt', { when: new Date(buddyConfig.auto_push_last_run_at).toLocaleString() })}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* ── Arkiver lagret hos peer ──────────────────────────────── */}
            {buddyConfig?.peer_configured && (
              <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ArrowUpToLine size={16} className="text-brand-500" />
                    <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{t('backup.pushedTitle')}</h2>
                  </div>
                  <button
                    onClick={() => void refetchPushedArchives()}
                    className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors text-zinc-400"
                    title="Opdater liste"
                  >
                    <RefreshCw size={13} />
                  </button>
                </div>
                <p className="text-sm text-zinc-500 dark:text-slate-400">
                  {t('backup.pushedDesc')}
                </p>
                {pushedArchives && pushedArchives.length > 0 ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-slate-400 pb-1 border-b border-zinc-100 dark:border-[#2d3148]">
                      <span>{pushedArchives.length} {pushedArchives.length !== 1 ? t('backup.archives') : t('backup.archive')}</span>
                      <span className="font-medium">{formatBytes(pushedArchives.reduce((s, a) => s + a.size_bytes, 0))} total</span>
                    </div>
                    <div className="space-y-1">
                      {pushedArchives.map(a => (
                        <div
                          key={a.filename}
                          className="flex items-center gap-2 rounded-lg border border-zinc-100 dark:border-[#2d3148] px-3 py-2 text-xs"
                        >
                          <span className="flex-1 font-mono text-zinc-700 dark:text-slate-300 truncate">{a.filename}</span>
                          <span className="text-zinc-400 shrink-0">{formatBytes(a.size_bytes)}</span>
                          <span className="text-zinc-400 shrink-0">{new Date(a.received_at).toLocaleDateString()}</span>
                          <button
                            onClick={() => { if (confirm(t('backup.confirmDeleteAtPeer'))) deletePushedMutation.mutate(a.filename) }}
                            disabled={deletePushedMutation.isPending}
                            className="shrink-0 p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors disabled:opacity-50"
                            title={t('backup.deleteAtPeer')}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : pushedArchives ? (
                  <p className="text-xs text-zinc-400">{t('backup.noPushed')}</p>
                ) : (
                  <p className="text-xs text-zinc-400">{t('backup.fetchFromPeer')}</p>
                )}
              </section>
            )}

            {/* ── Received buddy archives ──────────────────────────────── */}
            <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Server size={16} className="text-brand-500" />
                <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{t('backup.receivedTitle')}</h2>
              </div>
              <p className="text-sm text-zinc-500 dark:text-slate-400">
                  {t('backup.receivedDesc')}
              </p>

              {!buddyConfig?.has_receive_token ? (
                <p className="text-xs text-zinc-400 dark:text-slate-500">{t('backup.receiveTokenNeeded')}</p>
              ) : buddyReceived && buddyReceived.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-slate-400 pb-1 border-b border-zinc-100 dark:border-[#2d3148]">
                    <span>{buddyReceived.length} {buddyReceived.length !== 1 ? t('backup.archives') : t('backup.archive')}</span>
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
                <p className="text-xs text-zinc-400">{t('backup.noReceived')}</p>
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
            <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{t('backup.tokenTitle')}</h2>
          </div>
          <p className="text-sm text-zinc-500 dark:text-slate-400">
            {t('backup.tokenDesc')}
          </p>

          {isLoading ? (
            <p className="text-sm text-zinc-400">{t('backup.tokenLoading')}</p>
          ) : status?.has_password ? (
            <div className="space-y-3">
              <p className="text-sm text-zinc-600 dark:text-slate-400">
                {t('backup.tokenActive')}
                {status.created_at && <> Created {new Date(status.created_at).toLocaleDateString()}.</>}
                {status.last_used_at && <> Last used {new Date(status.last_used_at).toLocaleDateString()}.</>}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    if (confirm(t('backup.rotateTokenConfirm'))) {
                      generateMutation.mutate()
                    }
                  }}
                  disabled={generateMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 dark:border-[#2d3148] text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-50"
                >
                  <RefreshCw size={12} /> {t('backup.tokenRotate')}
                </button>
                <button
                  onClick={() => {
                    if (confirm(t('backup.revokeTokenConfirm'))) {
                      revokeMutation.mutate()
                    }
                  }}
                  disabled={revokeMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
                >
                  <Trash2 size={12} /> {t('backup.tokenRevoke')}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-zinc-500 dark:text-slate-400">{t('backup.tokenNone')}</p>
              <button
                onClick={() => generateMutation.mutate()}
                disabled={generateMutation.isPending}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
              >
                {t('backup.tokenGenerate')}
              </button>
            </div>
          )}

          {newToken && (
            <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-2">
              <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <p className="text-sm font-medium">{t('backup.tokenSaveNow')}</p>
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
