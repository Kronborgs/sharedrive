import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useRef, useEffect } from 'react'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/utils'
import type {
  AutoBackupConfig,
  BackupConfig,
  BackupPasswordStatus,
  BuddyArchive,
  BuddyTunnelStatus,
  BuddyUserConfig,
  FileItem,
  GeneratedBackupPassword,
  GeneratedBuddyReceiveToken,
  RestoreResult,
  TertiaryArchive,
} from '@/types/api'
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
import { ignorePromise } from '@/lib/ignore-promise'

export const Route = createFileRoute('/_auth/backup/')({
  component: BackupPage,
})

type TranslateFn = ReturnType<typeof useI18n>['t']

type BackupPushProgress = { total_bytes: number; sent_bytes: number; started_at: string; active: boolean }

async function copyBackupToken(token: string | null, setCopied: (value: boolean) => void) {
  if (!token) return
  await navigator.clipboard.writeText(token)
  setCopied(true)
  setTimeout(() => setCopied(false), 2500)
}

async function exportBackupArchive({
  token,
  folderIDs,
  t,
}: Readonly<{
  token: string
  folderIDs: string[]
  t: TranslateFn
}>) {
  if (!token.trim()) {
    toast.error(t('backup.enterTokenFirst'))
    return
  }

  try {
    const response = await fetch('/api/v1/backup/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        token: token.trim(),
        ...(folderIDs.length > 0 && { folder_ids: folderIDs }),
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
    const link = document.createElement('a')
    link.href = url
    link.download = `sharedrive-backup-${now}.shdbak`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    toast.success(t('backup.downloaded'))
  } catch {
    toast.error(t('backup.exportFailed'))
  }
}

async function restoreBackupArchive({
  token,
  file,
  fileInputRef,
  qc,
  setRestoreFile,
  setRestoreToken,
  t,
}: Readonly<{
  token: string
  file: File | null
  fileInputRef: React.RefObject<HTMLInputElement | null>
  qc: ReturnType<typeof useQueryClient>
  setRestoreFile: (value: File | null) => void
  setRestoreToken: (value: string) => void
  t: TranslateFn
}>) {
  if (!token.trim()) {
    toast.error(t('backup.enterToken'))
    return
  }
  if (!file) {
    toast.error(t('backup.selectFile'))
    return
  }

  const form = new FormData()
  form.append('token', token.trim())
  form.append('file', file)

  try {
    const response = await fetch('/api/v1/backup/restore', {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    const data = await response.json() as RestoreResult | { error: string }
    if (!response.ok) {
      toast.error((data as { error: string }).error ?? t('backup.restoreFailed'))
      return
    }

    const result = data as RestoreResult
    toast.success(
      `Restored ${result.files_restored} file(s) and ${result.folders_restored} folder(s) ` +
      `(${formatBytes(result.bytes_restored)})` +
      (result.skipped > 0 ? ` · ${result.skipped} skipped` : ''),
    )
    ignorePromise(qc.invalidateQueries({ queryKey: ['files'] }))
    ignorePromise(qc.invalidateQueries({ queryKey: ['me'] }))
    setRestoreFile(null)
    setRestoreToken('')
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  } catch {
    toast.error(t('backup.restoreFailed'))
  }
}

async function storeTertiaryArchive({
  token,
  folderIDs,
  setSaving,
  refetchTertiary,
  t,
}: Readonly<{
  token: string
  folderIDs: string[]
  setSaving: (value: boolean) => void
  refetchTertiary: () => Promise<unknown>
  t: TranslateFn
}>) {
  if (!token.trim()) {
    toast.error('Enter your backup token')
    return
  }

  setSaving(true)
  try {
    await api.post('/api/v1/backup/tertiary', {
      token: token.trim(),
      ...(folderIDs.length > 0 && { folder_ids: folderIDs }),
    })
    toast.success(t('backup.archiveSaved'))
    ignorePromise(refetchTertiary())
  } catch (error: unknown) {
    toast.error((error as Error).message ?? t('backup.archiveSaveFailed'))
  } finally {
    setSaving(false)
  }
}

async function pushBuddyArchive({
  token,
  hasPassword,
  buddyConfig,
  setBuddyPushing,
  setBuddyToken,
  refetchBuddyConfig,
  refetchPushedArchives,
  t,
}: Readonly<{
  token: string
  hasPassword: boolean
  buddyConfig: BuddyUserConfig | undefined
  setBuddyPushing: (value: boolean) => void
  setBuddyToken: (value: string) => void
  refetchBuddyConfig: () => Promise<any>
  refetchPushedArchives: () => Promise<unknown>
  t: TranslateFn
}>) {
  if (!token.trim()) {
    toast.error(t('backup.enterTokenFirst'))
    return
  }
  if (!hasPassword) {
    toast.error(t('backup.generateTokenFirst'))
    return
  }

  setBuddyPushing(true)
  try {
    await api.post('/api/v1/backup/buddy/push', {
      token: token.trim(),
      ...((buddyConfig?.auto_push_folder_ids?.length ?? 0) > 0 && { folder_ids: buddyConfig?.auto_push_folder_ids }),
    })
    toast.success(t('backup.pushStarted'))
    ignorePromise(refetchBuddyConfig())
    setTimeout(() => {
      refetchBuddyConfig().then(result => {
        if (!result.data?.push_in_progress && result.data?.last_push_error) {
          toast.error(t('backup.pushFailed') + ': ' + result.data.last_push_error)
        } else if (!result.data?.push_in_progress) {
          ignorePromise(refetchPushedArchives())
        }
      }).catch(() => {})
    }, 1500)
  } catch (error: unknown) {
    if ((error as { status?: number }).status === 403) {
      setBuddyToken('')
      sessionStorage.removeItem('sharedrive_backup_token')
      toast.error(t('backup.wrongToken'))
    } else {
      toast.error((error as Error).message ?? t('backup.pushFailed'))
    }
  } finally {
    setBuddyPushing(false)
  }
}
// ── file tree node (recursive) ───────────────────────────────────────────────

function FileTreeNode({
  item,
  depth,
  selectedIDs,
  onToggle,
  ancestorIDs,
  allChecked,
  nearestSelectedAncestorID,
}: Readonly<{
  item: FileItem
  depth: number
  selectedIDs: string[]
  onToggle: (id: string, nearestAncestorID?: string) => void
  ancestorIDs: Set<string>
  allChecked: boolean
  nearestSelectedAncestorID?: string
}>) {
  const { t } = useI18n()
  const isAncestor = ancestorIDs.has(item.id)
  // isExplicit: this item is directly in selectedIDs (or allChecked covers everything)
  const isExplicit = allChecked || selectedIDs.includes(item.id)
  // inheritedSelected: an ancestor is explicitly selected, so this item is included implicitly
  const inheritedSelected = !isExplicit && !!nearestSelectedAncestorID
  const isChecked = isExplicit || inheritedSelected
  const isIndeterminate = !isChecked && isAncestor
  const rowClassName = getFileTreeRowClass(isChecked, isIndeterminate)
  const labelClassName = getFileTreeLabelClass(isExplicit, inheritedSelected, isIndeterminate)
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
  const expandControl = item.is_folder ? (
    <button
      type="button"
      onClick={() => setExpanded(e => !e)}
      className="p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-200 transition-colors shrink-0"
    >
      {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
    </button>
  ) : (
    <span className="w-4 shrink-0" />
  )
  const itemIcon = getFileTreeItemIcon(item.is_folder, isChecked, isIndeterminate)
  const itemNameClassName = getFileTreeNameClass(isChecked, isIndeterminate)
  const childrenContent = getFileTreeChildrenContent({
    expanded,
    isFolder: item.is_folder,
    loadingChildren,
    children,
    depth,
    t,
    selectedIDs,
    onToggle,
    ancestorIDs,
    allChecked,
    ancestorIDForChildren,
  })

  return (
    <div>
      <div
        className={`flex items-center gap-1 py-1 rounded-md px-1 transition-colors ${rowClassName}`}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {expandControl}
        <label className="flex items-center gap-1.5 cursor-pointer flex-1 min-w-0">
          <span className={`flex items-center justify-center w-4 h-4 rounded shrink-0 border transition-colors ${labelClassName}`}>
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
          {itemIcon}
          <span className={`text-xs truncate ${itemNameClassName}`}>
            {item.name}
          </span>
        </label>
      </div>
      {childrenContent}
    </div>
  )
}

// ── shared folder-picker component ───────────────────────────────────────────

function FolderPicker({
  selectedIDs,
  onChange,
}: Readonly<{
  selectedIDs: string[]
  onChange: (ids: string[]) => void
}>) {
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
    queryKey: ['files', 'ancestors', selectedIDs.slice().sort((a, b) => a.localeCompare(b)).join(',')],
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
  const selectionLabel = getFolderPickerSelectionLabel(allChecked, manualMode, selectedIDs.length, t)

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
        {selectionLabel}
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
function PushProgressBar({ progress }: Readonly<{ progress: { total_bytes: number; sent_bytes: number; started_at: string; active: boolean } }>) {
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

  const { data: pushProgress } = useQuery({
    queryKey: ['backup', 'push-progress'],
    queryFn: ({ signal }) => api.get<BackupPushProgress>('/api/v1/backup/buddy/push/progress', signal),
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
      ignorePromise(qc.invalidateQueries({ queryKey: ['backup', 'password'] }))
    },
    onError: () => toast.error(t('backup.tokenPasswordFailed')),
  })

  const revokeMutation = useMutation({
    mutationFn: () => api.delete('/api/v1/backup/password'),
    onSuccess: () => {
      setNewToken(null)
      ignorePromise(qc.invalidateQueries({ queryKey: ['backup', 'password'] }))
      toast.success(t('backup.tokenRevoked'))
    },
    onError: () => toast.error(t('backup.tokenRevokeFailed')),
  })

  const deleteTertiaryMutation = useMutation({
    mutationFn: (filename: string) => api.delete(`/api/v1/backup/tertiary/${encodeURIComponent(filename)}`),
    onSuccess: () => { ignorePromise(refetchTertiary()); toast.success(t('backup.archiveDeleted')) },
    onError: () => toast.error(t('backup.archiveDeleteFailed')),
  })

  const deleteBuddyMutation = useMutation({
    mutationFn: (filename: string) => api.delete(`/api/v1/backup/buddy/received/${encodeURIComponent(filename)}`),
    onSuccess: () => { ignorePromise(refetchBuddyReceived()); toast.success(t('backup.archiveDeleted')) },
    onError: () => toast.error(t('backup.archiveDeleteFailed')),
  })

  const setQuotaMutation = useMutation({
    mutationFn: (bytes: number | null) => api.put('/api/v1/backup/buddy/quota', { quota_bytes: bytes }),
  })

  const saveAutoConfigMutation = useMutation({
    mutationFn: (body: { enabled: boolean; interval_hours: number; retention_days: number; folder_ids: string[] }) =>
      api.put('/api/v1/backup/auto', body),
    onSuccess: () => { ignorePromise(refetchAutoConfig()); toast.success(t('backup.autoSaved')) },
    onError: () => toast.error(t('backup.autoSaveFailed')),
  })

  const generateReceiveTokenMutation = useMutation({
    mutationFn: () => api.post<GeneratedBuddyReceiveToken>('/api/v1/backup/buddy/receive-token', {}),
    onSuccess: (data) => {
      setNewReceiveToken(data.token)
      setReceiveTokenCopied(false)
      ignorePromise(refetchBuddyConfig())
    },
    onError: () => toast.error(t('backup.receiveTokenGenFailed')),
  })

  const revokeReceiveTokenMutation = useMutation({
    mutationFn: () => api.delete('/api/v1/backup/buddy/receive-token'),
    onSuccess: () => {
      setNewReceiveToken(null)
      ignorePromise(refetchBuddyConfig())
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
      ignorePromise(refetchBuddyConfig())
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
      ignorePromise(refetchBuddyConfig())
      setBuddyToken('')
      toast.success(t('backup.peerCleared'))
    },
    onError: () => toast.error(t('backup.peerClearFailed')),
  })

  const tunnelConnectMutation = useMutation({
    mutationFn: () => api.post('/api/v1/backup/buddy/tunnel/connect', {}),
    onSuccess: () => { ignorePromise(refetchTunnelStatus()); toast.success(t('backup.tunnelConnected')) },
    onError: (e: unknown) => toast.error((e as Error).message ?? t('backup.tunnelConnectFailed')),
  })

  const tunnelDisconnectMutation = useMutation({
    mutationFn: () => api.delete('/api/v1/backup/buddy/tunnel/connect'),
    onSuccess: () => { ignorePromise(refetchTunnelStatus()); toast.success(t('backup.tunnelDisconnected')) },
    onError: () => toast.error(t('backup.tunnelDisconnectFailed')),
  })

  const deletePushedMutation = useMutation({
    mutationFn: (filename: string) => api.delete(`/api/v1/backup/buddy/pushed/${encodeURIComponent(filename)}`),
    onSuccess: () => { ignorePromise(refetchPushedArchives()); toast.success(t('backup.peerArchiveDeleted')) },
    onError: () => toast.error(t('backup.peerArchiveDeleteFailed')),
  })

  // ── handlers ──────────────────────────────────────────────────────────────

    const handleCopyToken = () => copyBackupToken(newToken, setTokenCopied)

    const handleExport = () => exportBackupArchive({ token: exportToken, folderIDs: exportFolderIDs, t })

    const handleRestore = () => restoreBackupArchive({ token: restoreToken, file: restoreFile, fileInputRef, qc, setRestoreFile, setRestoreToken, t })

    const handleStoreTertiary = () => storeTertiaryArchive({ token: tertiaryToken, folderIDs: tertiaryFolderIDs, setSaving: setTertiarySaving, refetchTertiary, t })

    const handleCopyReceiveToken = () => copyBackupToken(newReceiveToken, setReceiveTokenCopied)

    const handleBuddyPush = () => pushBuddyArchive({ token: buddyToken, hasPassword: !!status?.has_password, buddyConfig, setBuddyPushing, setBuddyToken, refetchBuddyConfig, refetchPushedArchives, t })

  // ── render ────────────────────────────────────────────────────────────────

  const hasToken = status?.has_password ?? false
  const model = {
    t,
    hasToken,
    activeTab,
    setActiveTab,
    isLoading,
    status,
    config,
    tertiaryList,
    autoConfig,
    buddyConfig,
    buddyReceived,
    pushedArchives,
    tunnelStatus,
    pushProgress,
    newToken,
    tokenCopied,
    exportToken,
    exportFolderIDs,
    restoreToken,
    restoreFile,
    fileInputRef,
    tertiaryToken,
    tertiaryFolderIDs,
    tertiarySaving,
    buddyToken,
    buddyPushing,
    isPushing,
    newReceiveToken,
    receiveTokenCopied,
    peerURLInput,
    peerUserIDInput,
    peerTokenInput,
    quotaGB,
    generateMutation,
    revokeMutation,
    deleteTertiaryMutation,
    deleteBuddyMutation,
    setQuotaMutation,
    saveAutoConfigMutation,
    generateReceiveTokenMutation,
    revokeReceiveTokenMutation,
    savePeerConfigMutation,
    clearPeerConfigMutation,
    tunnelConnectMutation,
    tunnelDisconnectMutation,
    deletePushedMutation,
    handleCopyToken,
    handleExport,
    handleRestore,
    handleStoreTertiary,
    handleCopyReceiveToken,
    handleBuddyPush,
    setExportToken,
    setExportFolderIDs,
    setRestoreToken,
    setRestoreFile,
    setTertiaryToken,
    setTertiaryFolderIDs,
    setBuddyToken,
    saveToken,
    setPeerURLInput,
    setPeerUserIDInput,
    setPeerTokenInput,
    setQuotaGB,
    refetchBuddyConfig,
    refetchPushedArchives,
    refetchAutoConfig,
  }

  return <BackupPageContent model={model} />
}

function BackupTokenRequiredNotice({ t }: Readonly<{ t: TranslateFn }>) {
  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/10 px-6 py-8 text-center space-y-3">
      <ShieldCheck size={32} className="mx-auto text-amber-500" />
      <p className="text-sm font-medium text-amber-700 dark:text-amber-400">{t('backup.tokenRequired')}</p>
      <p className="text-xs text-amber-600 dark:text-amber-500">{t('backup.tokenRequiredDesc')}</p>
    </div>
  )
}

function BackupPageTabs({ model }: Readonly<{ model: any }>) {
  const tokenTabClass = model.activeTab === 'token'
    ? 'border-brand-500 text-brand-600 dark:text-brand-400'
    : 'border-transparent text-zinc-500 dark:text-slate-400 hover:text-zinc-700 dark:hover:text-slate-200 cursor-pointer'

  return (
    <div className="flex border-b border-zinc-200 dark:border-[#2d3148]">
      <button type="button" onClick={() => model.hasToken && model.setActiveTab('storage')} className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${getBackupTabClass(model.activeTab === 'storage', model.hasToken)}`}><HardDrive size={14} /> {model.t('backup.tabStorage')}</button>
      <button type="button" onClick={() => model.hasToken && model.setActiveTab('buddy')} className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${getBackupTabClass(model.activeTab === 'buddy', model.hasToken)}`}><Server size={14} /> {model.t('backup.tabBuddy')}</button>
      <button type="button" onClick={() => model.setActiveTab('token')} className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${tokenTabClass}`}><ShieldCheck size={14} /> {model.t('backup.tabToken')}</button>
    </div>
  )
}

function BackupStorageTabContent({ model }: Readonly<{ model: any }>) {
  if (!model.hasToken) {
    return <BackupTokenRequiredNotice t={model.t} />
  }

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
        <div className="flex items-center gap-2"><HardDrive size={16} className="text-brand-500" /><h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{model.t('backup.storageTitle')}</h2></div>
        <p className="text-sm text-zinc-500 dark:text-slate-400">{model.t('backup.storageDesc')}</p>
        <p className="text-xs text-zinc-400 dark:text-slate-500">{model.t('backup.tabToken')}</p>
        {model.config?.tertiary_enabled && model.config.disk_total_bytes != null && model.config.disk_total_bytes > 0 && <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-slate-400"><HardDrive size={12} /><span>{model.t('backup.diskFree', { free: formatBytes(model.config.disk_free_bytes ?? 0), total: formatBytes(model.config.disk_total_bytes) })}</span></div>}
        {!model.config?.tertiary_enabled ? (
          <div className="rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-4 py-3 text-xs text-zinc-500 dark:text-slate-400 space-y-1"><p className="font-medium text-zinc-700 dark:text-slate-300">{model.t('backup.notConfigured')}</p><p>Set <code className="bg-zinc-100 dark:bg-[#1a1d27] px-1 rounded">BACKUPS_ROOT=/mnt/backup</code> in your environment to enable this feature.</p></div>
        ) : (
          <>
            <div className="flex gap-2">
              <input type="password" value={model.tertiaryToken} onChange={e => { model.setTertiaryToken(e.target.value); model.saveToken(e.target.value) }} placeholder="Backup token" className="flex-1 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500" />
              <button onClick={model.handleStoreTertiary} disabled={!model.tertiaryToken.trim() || model.tertiarySaving} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50">{model.tertiarySaving ? <><RefreshCw size={14} className="animate-spin" /> Saving…</> : <><HardDrive size={14} /> Save</>}</button>
            </div>
            <FolderPicker selectedIDs={model.tertiaryFolderIDs} onChange={ids => { model.setTertiaryFolderIDs(ids); model.saveAutoConfigMutation.mutate({ enabled: model.autoConfig?.enabled ?? false, interval_hours: model.autoConfig?.interval_hours ?? 24, retention_days: model.autoConfig?.retention_days ?? 30, folder_ids: ids }) }} />
            {model.tertiaryList && model.tertiaryList.length > 0 && <div className="space-y-1 pt-1"><p className="text-xs font-medium text-zinc-500 dark:text-slate-400">{model.t('backup.storedArchives')}</p>{model.tertiaryList.map((archive: TertiaryArchive) => <div key={archive.filename} className="flex items-center gap-2 rounded-lg border border-zinc-100 dark:border-[#2d3148] px-3 py-2 text-xs"><span className="flex-1 font-mono text-zinc-700 dark:text-slate-300 truncate">{archive.filename}</span><span className="text-zinc-400 shrink-0">{formatBytes(archive.size_bytes)}</span><a href={`/api/v1/backup/tertiary/${encodeURIComponent(archive.filename)}`} download={archive.filename} className="shrink-0 p-1 rounded hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors" title="Download"><Download size={12} /></a><button onClick={() => model.deleteTertiaryMutation.mutate(archive.filename)} className="shrink-0 p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors" title="Delete"><Trash2 size={12} /></button></div>)}</div>}
            {model.tertiaryList?.length === 0 && <p className="text-xs text-zinc-400">{model.t('backup.noArchives')}</p>}
          </>
        )}
      </section>

      {model.config?.tertiary_enabled && (
        <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
          <div className="flex items-center gap-2"><Clock size={16} className="text-brand-500" /><h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{model.t('backup.autoTitle')}</h2></div>
          <p className="text-sm text-zinc-500 dark:text-slate-400">Schedule automatic backups to server storage. Uses the same folders selected above. A new archive is only created when your files have changed.</p>
          <div className="space-y-3">
            <div className="flex items-center justify-between"><span className="text-sm text-zinc-700 dark:text-slate-300">{model.t('backup.enableAuto')}</span><button type="button" onClick={() => model.saveAutoConfigMutation.mutate({ enabled: !(model.autoConfig?.enabled ?? false), interval_hours: model.autoConfig?.interval_hours ?? 24, retention_days: model.autoConfig?.retention_days ?? 30, folder_ids: model.tertiaryFolderIDs })} className="transition-colors" title={model.autoConfig?.enabled ? 'Disable' : 'Enable'}>{model.autoConfig?.enabled ? <ToggleRight size={28} className="text-brand-500" /> : <ToggleLeft size={28} className="text-zinc-400" />}</button></div>
            <div className="flex items-center gap-3"><label className="text-xs text-zinc-500 dark:text-slate-400 shrink-0">{model.t('backup.interval')}</label><select value={model.autoConfig?.interval_hours ?? 24} onChange={e => model.saveAutoConfigMutation.mutate({ enabled: model.autoConfig?.enabled ?? false, interval_hours: Number(e.target.value), retention_days: model.autoConfig?.retention_days ?? 30, folder_ids: model.tertiaryFolderIDs })} className="text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] px-3 py-1.5 text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500 [&>option]:bg-white [&>option]:dark:bg-[#1a1d27] [&>option]:text-zinc-900 [&>option]:dark:text-slate-100"><option value={6}>{model.t('backup.every6h')}</option><option value={12}>{model.t('backup.every12h')}</option><option value={24}>{model.t('backup.every24h')}</option><option value={48}>{model.t('backup.every48h')}</option><option value={168}>{model.t('backup.weekly')}</option></select></div>
            <div className="flex items-center gap-3"><label className="text-xs text-zinc-500 dark:text-slate-400 shrink-0">{model.t('backup.keepBackups')}</label><select value={model.autoConfig?.retention_days ?? 30} onChange={e => model.saveAutoConfigMutation.mutate({ enabled: model.autoConfig?.enabled ?? false, interval_hours: model.autoConfig?.interval_hours ?? 24, retention_days: Number(e.target.value), folder_ids: model.tertiaryFolderIDs })} className="text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] px-3 py-1.5 text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500 [&>option]:bg-white [&>option]:dark:bg-[#1a1d27] [&>option]:text-zinc-900 [&>option]:dark:text-slate-100"><option value={7}>{model.t('backup.7days')}</option><option value={14}>{model.t('backup.14days')}</option><option value={30}>{model.t('backup.30days')}</option><option value={60}>{model.t('backup.60days')}</option><option value={90}>{model.t('backup.90days')}</option><option value={180}>{model.t('backup.180days')}</option><option value={365}>{model.t('backup.1year')}</option></select></div>
            {model.autoConfig?.last_run_at && <p className="text-xs text-zinc-400">{model.t('backup.lastAutoAt', { when: new Date(model.autoConfig.last_run_at).toLocaleString() })}</p>}
            {model.autoConfig?.auto_failed_since && <div className="flex items-start gap-3 rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/10 px-4 py-3 text-sm"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-500" /><div><p className="font-medium text-red-700 dark:text-red-400">{model.t('backup.autoFailing')}</p><p className="text-xs text-red-600 dark:text-red-500 mt-0.5">{model.t('backup.failingSince', { when: new Date(model.autoConfig.auto_failed_since).toLocaleString() })}</p></div></div>}
          </div>
        </section>
      )}

      {model.config?.tertiary_enabled && (
        <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-3">
          <div className="flex items-center gap-2"><Bell size={16} className="text-brand-500" /><h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{model.t('backup.notificationsTitle')}</h2></div>
          <div className="flex items-center gap-3"><input id="backup-notify-on-failure" type="checkbox" checked={model.autoConfig?.notify_on_failure ?? true} onChange={e => { api.put('/api/v1/backup/notify', { enabled: e.target.checked }).then(() => { ignorePromise(model.refetchAutoConfig()); ignorePromise(model.refetchBuddyConfig()) }).catch(() => toast.error(model.t('backup.savingFailed'))) }} className="h-4 w-4 rounded border-zinc-300 text-brand-600 focus:ring-brand-500" /><label htmlFor="backup-notify-on-failure" className="cursor-pointer"><p className="text-sm text-zinc-700 dark:text-slate-300">{model.t('backup.notifyOnFailure')}</p><p className="text-xs text-zinc-400 dark:text-slate-500">{model.t('backup.notifyOnFailureDesc')}</p></label></div>
        </section>
      )}

      <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
        <div className="flex items-center gap-2"><Download size={16} className="text-brand-500" /><h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{model.t('backup.exportTitle')}</h2></div>
        <p className="text-sm text-zinc-500 dark:text-slate-400">Downloads an AES-256 encrypted archive (<code className="text-xs">.shdbak</code>) to your device.</p>
        <div className="flex gap-2"><input type="password" value={model.exportToken} onChange={e => { model.setExportToken(e.target.value); model.saveToken(e.target.value) }} placeholder={model.t('backup.tokenPlaceholder')} className="flex-1 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500" /><button onClick={model.handleExport} disabled={!model.exportToken.trim()} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"><Download size={14} /> {model.t('backup.download')}</button></div>
        <FolderPicker selectedIDs={model.exportFolderIDs} onChange={model.setExportFolderIDs} />
      </section>

      <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
        <div className="flex items-center gap-2"><Upload size={16} className="text-brand-500" /><h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{model.t('backup.restoreTitle')}</h2></div>
        <p className="text-sm text-zinc-500 dark:text-slate-400">Upload a <code className="text-xs">.shdbak</code> file to restore files. Existing files are skipped — the operation is safe to repeat.</p>
        <div className="space-y-2"><input type="password" value={model.restoreToken} onChange={e => model.setRestoreToken(e.target.value)} placeholder={model.t('backup.tokenPlaceholder')} className="w-full text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500" /><div className="flex gap-2 items-center"><label className="flex-1 flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg border border-dashed border-zinc-300 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"><Upload size={14} className="text-zinc-400" /><span className="text-sm text-zinc-500 dark:text-slate-400 truncate">{model.restoreFile ? model.restoreFile.name : model.t('backup.chooseFile')}</span><input ref={model.fileInputRef} type="file" accept=".shdbak" className="hidden" onChange={e => model.setRestoreFile(e.target.files?.[0] ?? null)} /></label><button onClick={model.handleRestore} disabled={!model.restoreToken.trim() || !model.restoreFile} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50">{model.t('backup.restore')}</button></div></div>
      </section>
    </div>
  )
}
function BackupBuddyOverviewSection({ model }: Readonly<{ model: any }>) {
  return (
    <>
      {model.buddyConfig?.push_failed_since && <div className="rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 px-4 py-3 flex items-start gap-3"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-500" /><div className="space-y-0.5 flex-1"><p className="text-sm font-medium text-red-700 dark:text-red-400">{model.t('backup.buddyPushFailing')}</p><p className="text-xs text-red-600 dark:text-red-400">{model.t('backup.failingSince', { when: new Date(model.buddyConfig.push_failed_since).toLocaleString() })}</p>{model.buddyConfig.last_push_error && <p className="text-xs text-red-600 dark:text-red-400 font-mono mt-1 break-all">{model.buddyConfig.last_push_error}</p>}{model.buddyConfig.last_push_error?.includes('413') && <p className="text-xs text-amber-700 dark:text-amber-400 mt-1.5">{model.t('backup.hint413')}</p>}</div></div>}
      <div className={`grid gap-3 ${model.buddyConfig?.peer_configured ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <div className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-4 space-y-1"><div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-slate-400"><ArrowDownToLine size={13} className="text-brand-500" />{model.t('backup.youStoreForBuddy')}</div>{model.buddyConfig?.has_receive_token && model.buddyReceived && model.buddyReceived.length > 0 ? <><p className="text-lg font-semibold text-zinc-900 dark:text-slate-100">{formatBytes(model.buddyReceived.reduce((sum: number, archive: BuddyArchive) => sum + archive.size_bytes, 0))}</p><p className="text-xs text-zinc-400">{model.buddyReceived.length} {model.buddyReceived.length !== 1 ? model.t('backup.archives') : model.t('backup.archive')}</p></> : <p className="text-sm text-zinc-400 dark:text-slate-500">{model.t('backup.noReceived')}</p>}</div>
        <div className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-4 space-y-1"><div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-slate-400"><ArrowUpToLine size={13} className="text-brand-500" />{model.t('backup.buddyStoresForYou')}</div>{renderPushedArchiveSummary(model.buddyConfig?.peer_configured ?? false, model.pushedArchives, model.buddyConfig?.last_push_at, model.buddyConfig?.last_push_bytes ?? 0, model.t)}</div>
        {model.buddyConfig?.peer_configured && <div className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-4 space-y-1"><div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-slate-400"><Network size={13} className="text-brand-500" />Reverse tunnel</div>{renderTunnelStatusContent(model.tunnelStatus, model.tunnelConnectMutation.isPending, model.tunnelDisconnectMutation.isPending, () => model.tunnelConnectMutation.mutate(), () => model.tunnelDisconnectMutation.mutate(), model.t)}</div>}
      </div>
    </>
  )
}

function BackupBuddyConfigSection({ model }: Readonly<{ model: any }>) {
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-5">
      <div className="flex items-center gap-2"><Server size={16} className="text-brand-500" /><h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{model.t('backup.buddyTitle')}</h2></div>
      <p className="text-sm text-zinc-500 dark:text-slate-400">{model.t('backup.buddyDesc')}</p>
      <div className="space-y-3 border-t border-zinc-100 dark:border-[#2d3148] pt-4">
        <p className="text-xs font-semibold text-zinc-700 dark:text-slate-300">{model.t('backup.receiveInfo')}</p>
        <p className="text-xs text-zinc-500 dark:text-slate-400">{model.t('backup.receiveInfoDesc')}</p>
        <div className="flex items-center gap-2"><span className="text-xs text-zinc-500 dark:text-slate-400 w-20 shrink-0">{model.t('backup.serverUrl')}</span><code className="flex-1 text-xs font-mono bg-zinc-50 dark:bg-[#0f1117] border border-zinc-200 dark:border-[#2d3148] rounded px-2 py-1 truncate">{window.location.origin}</code><button onClick={() => { ignorePromise(navigator.clipboard.writeText(window.location.origin)); toast.success(model.t('backup.urlCopied')) }} className="shrink-0 p-1.5 rounded border border-zinc-200 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors" title={model.t('backup.copyUrl')}><Copy size={12} /></button></div>
        <div className="flex items-center gap-2"><span className="text-xs text-zinc-500 dark:text-slate-400 w-20 shrink-0">{model.t('backup.yourUserId')}</span><code className="flex-1 text-xs font-mono bg-zinc-50 dark:bg-[#0f1117] border border-zinc-200 dark:border-[#2d3148] rounded px-2 py-1 truncate">{model.buddyConfig?.user_id ?? '…'}</code><button onClick={() => { if (model.buddyConfig?.user_id) { ignorePromise(navigator.clipboard.writeText(model.buddyConfig.user_id)); toast.success(model.t('backup.userIdCopied')) } }} className="shrink-0 p-1.5 rounded border border-zinc-200 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors" title={model.t('backup.copyUserId')}><Copy size={12} /></button></div>
        <div className="flex items-center gap-2"><span className="text-xs text-zinc-500 dark:text-slate-400 w-20 shrink-0">{model.t('backup.receiveTokenLabel')}</span>{model.buddyConfig?.has_receive_token ? <span className="flex-1 text-xs font-mono text-zinc-500 dark:text-slate-400">{model.buddyConfig.receive_token_prefix}••••••••••••••••••••••••••••••••••••</span> : <span className="flex-1 text-xs text-zinc-400">{model.t('backup.notGeneratedYet')}</span>}<button onClick={() => model.generateReceiveTokenMutation.mutate()} disabled={model.generateReceiveTokenMutation.isPending} className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-zinc-200 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-50"><RefreshCw size={10} /> {model.buddyConfig?.has_receive_token ? model.t('backup.rotate') : model.t('backup.generate')}</button>{model.buddyConfig?.has_receive_token && <button onClick={() => { if (confirm(model.t('backup.revokeReceiveToken'))) model.revokeReceiveTokenMutation.mutate() }} disabled={model.revokeReceiveTokenMutation.isPending} className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"><Trash2 size={10} /> {model.t('backup.revoke')}</button>}</div>
        {model.newReceiveToken && <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-2"><div className="flex items-start gap-2 text-amber-700 dark:text-amber-400"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><p className="text-xs font-medium">{model.t('backup.receiveTokenSaveNow')}</p></div><div className="flex items-center gap-2"><code className="flex-1 text-xs font-mono bg-white dark:bg-[#0f1117] border border-amber-200 dark:border-amber-800 rounded px-3 py-2 break-all text-zinc-800 dark:text-slate-200 select-all">{model.newReceiveToken}</code><button onClick={model.handleCopyReceiveToken} className="shrink-0 p-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors" title={model.t('backup.copyReceiveToken')}>{model.receiveTokenCopied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}</button></div></div>}
      </div>
    </section>
  )
}

function BackupBuddyPushSection({ model }: Readonly<{ model: any }>) {
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
      <div className="space-y-2"><p className="text-xs font-semibold text-zinc-700 dark:text-slate-300">{model.t('backup.pushToPeer')}</p><p className="text-xs text-zinc-500 dark:text-slate-400">{model.t('backup.pushToPeerDesc')}</p><div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900/50 px-3 py-2.5 space-y-0.5"><p className="text-xs font-medium text-blue-700 dark:text-blue-400">{model.t('backup.encKeyExplainTitle')}</p><p className="text-xs text-blue-600 dark:text-blue-500">{model.t('backup.encKeyExplainDesc')}</p></div></div>
      {model.buddyConfig?.peer_configured ? <div className="space-y-3"><div className="flex items-center gap-2 rounded-lg bg-zinc-50 dark:bg-[#0f1117] border border-zinc-200 dark:border-[#2d3148] px-3 py-2"><span className="text-xs text-zinc-500 dark:text-slate-400">Peer:</span><span className="flex-1 text-xs font-mono text-zinc-700 dark:text-slate-300 truncate">{model.buddyConfig.peer_url}</span><button onClick={() => { if (confirm(model.t('backup.clearPeerConfig'))) model.clearPeerConfigMutation.mutate() }} disabled={model.clearPeerConfigMutation.isPending} className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs font-medium border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"><Trash2 size={10} /> {model.t('backup.peerClear')}</button></div>{model.buddyToken.trim() ? <div className="space-y-2"><div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-500"><Check size={12} />{model.t('backup.encKeyReady')}</div><button onClick={model.handleBuddyPush} disabled={model.isPushing} className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-semibold bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50">{model.isPushing ? <><RefreshCw size={15} className="animate-spin" /> {model.t('backup.pushingNow')}</> : <><ArrowUpToLine size={15} /> {model.t('backup.pushNow')}</>}</button>{model.isPushing && model.pushProgress && model.pushProgress.total_bytes > 0 && <PushProgressBar progress={model.pushProgress} />}{model.buddyConfig?.push_in_progress && !model.buddyPushing && <button onClick={async () => { await api.delete('/api/v1/backup/buddy/push-in-progress'); ignorePromise(model.refetchBuddyConfig()) }} className="w-full text-xs text-zinc-500 dark:text-slate-400 underline hover:text-zinc-700 dark:hover:text-slate-200">{model.t('backup.resetStuckPush')}</button>}{model.buddyConfig?.last_push_error && <p className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1"><AlertTriangle size={12} /> {model.buddyConfig.last_push_error}</p>}<FolderPicker selectedIDs={model.buddyConfig?.auto_push_folder_ids ?? []} onChange={ids => { api.put('/api/v1/backup/buddy/auto', { enabled: model.buddyConfig?.auto_push_enabled ?? false, interval_hours: model.buddyConfig?.auto_push_interval_hours ?? 24, on_change: model.buddyConfig?.auto_push_on_change ?? false, folder_ids: ids }).then(() => ignorePromise(model.refetchBuddyConfig())).catch(() => toast.error(model.t('backup.savingFailed'))) }} /><button type="button" onClick={() => model.setBuddyToken('')} className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300 transition-colors">{model.t('backup.useAnotherKey')}</button></div> : <div className="space-y-2"><div className="flex gap-2"><input type="password" value={model.buddyToken} onChange={e => { model.setBuddyToken(e.target.value); model.saveToken(e.target.value) }} placeholder={model.t('backup.encKeyPlaceholder')} className="flex-1 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500" /><button onClick={model.handleBuddyPush} disabled={!model.buddyToken.trim() || model.isPushing} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50">{model.isPushing ? <><RefreshCw size={14} className="animate-spin" /> {model.t('backup.pushingNow')}</> : <><ArrowUpToLine size={14} /> Push</>}</button></div>{model.buddyConfig?.last_push_error && <p className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1"><AlertTriangle size={12} /> {model.buddyConfig.last_push_error}</p>}<p className="text-xs text-zinc-400">{model.t('backup.tabToken')}</p><FolderPicker selectedIDs={model.buddyConfig?.auto_push_folder_ids ?? []} onChange={ids => { api.put('/api/v1/backup/buddy/auto', { enabled: model.buddyConfig?.auto_push_enabled ?? false, interval_hours: model.buddyConfig?.auto_push_interval_hours ?? 24, on_change: model.buddyConfig?.auto_push_on_change ?? false, folder_ids: ids }).then(() => ignorePromise(model.refetchBuddyConfig())).catch(() => toast.error(model.t('backup.savingFailed'))) }} /></div>}</div> : <div className="space-y-2"><input type="url" value={model.peerURLInput} onChange={e => model.setPeerURLInput(e.target.value)} placeholder={model.t('backup.peerUrlPlaceholder')} className="w-full text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500" /><input type="text" value={model.peerUserIDInput} onChange={e => model.setPeerUserIDInput(e.target.value)} placeholder={model.t('backup.peerUserIdPlaceholder')} className="w-full text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500" /><div className="flex gap-2"><input type="password" value={model.peerTokenInput} onChange={e => model.setPeerTokenInput(e.target.value)} placeholder={model.t('backup.peerTokenPlaceholder')} className="flex-1 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-3 py-2 text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500" /><button onClick={() => model.savePeerConfigMutation.mutate()} disabled={!model.peerURLInput.trim() || !model.peerUserIDInput.trim() || !model.peerTokenInput.trim() || model.savePeerConfigMutation.isPending} className="shrink-0 px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50">{model.t('users.save')}</button></div></div>}
    </section>
  )
}
function BackupBuddyQuotaSection({ model }: Readonly<{ model: any }>) {
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-3">
      <p className="text-xs font-semibold text-zinc-700 dark:text-slate-300">{model.t('backup.quotaTitle')}</p>
      <p className="text-xs text-zinc-500 dark:text-slate-400">{model.t('backup.quotaDesc')}</p>
      <div className="space-y-1.5"><div className="space-y-0.5"><div className="flex items-center justify-between text-xs text-zinc-500 dark:text-slate-400"><span>{model.t('backup.quotaUsage')}</span><span>{formatBytes((model.buddyReceived ?? []).reduce((sum: number, archive: BuddyArchive) => sum + archive.size_bytes, 0))}{model.buddyConfig?.receive_quota_bytes != null && ` / ${formatBytes(model.buddyConfig.receive_quota_bytes)}`}</span></div>{model.buddyConfig?.receive_quota_bytes != null && <div className="w-full bg-zinc-100 dark:bg-[#2d3148] rounded-full h-1.5"><div className="bg-brand-500 h-1.5 rounded-full transition-all" style={{ width: `${Math.min(100, ((model.buddyReceived ?? []).reduce((sum: number, archive: BuddyArchive) => sum + archive.size_bytes, 0) / model.buddyConfig.receive_quota_bytes) * 100)}%` }} /></div>}</div><div className="flex items-center justify-between text-xs text-zinc-500 dark:text-slate-400"><span>{model.t('backup.peerUsage')}</span><span>{formatBytes(model.buddyConfig?.peer_stored_bytes ?? 0)}</span></div></div>
      <div className="flex items-center gap-2"><input type="number" min="1" step="1" value={model.quotaGB} onChange={e => model.setQuotaGB(e.target.value)} placeholder={model.t('backup.quotaUnlimited')} className="w-28 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500" /><span className="text-xs text-zinc-500">GB</span><button onClick={() => { const bytes = model.quotaGB.trim() ? Math.round(Number.parseFloat(model.quotaGB) * 1073741824) : null; model.setQuotaMutation.mutate(bytes, { onSuccess: () => { toast.success(model.t('backup.quotaSaved')); ignorePromise(model.refetchBuddyConfig()) }, onError: () => toast.error(model.t('backup.quotaSaveFailed')) }) }} disabled={model.setQuotaMutation.isPending} className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium disabled:opacity-50 transition-colors">{model.t('backup.quotaSave')}</button></div>
      <p className="text-xs text-zinc-400 italic">{model.t('backup.fairTrade')}</p>
    </section>
  )
}

function BackupBuddyAutoPushSection({ model }: Readonly<{ model: any }>) {
  if (!model.buddyConfig?.peer_configured) return null
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4"><div className="flex items-center gap-2"><Clock size={16} className="text-brand-500" /><h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{model.t('backup.autoBuddyTitle')}</h2></div><p className="text-sm text-zinc-500 dark:text-slate-400">{model.t('backup.autoBuddyDesc')}</p><div className="space-y-3"><div className="flex items-center gap-3"><button type="button" role="switch" aria-checked={model.buddyConfig?.auto_push_enabled ?? false} onClick={() => { const next = !(model.buddyConfig?.auto_push_enabled ?? false); api.put('/api/v1/backup/buddy/auto', { enabled: next, interval_hours: model.buddyConfig?.auto_push_interval_hours ?? 24, on_change: model.buddyConfig?.auto_push_on_change ?? false, folder_ids: model.buddyConfig?.auto_push_folder_ids ?? [] }).then(() => ignorePromise(model.refetchBuddyConfig())).catch(() => toast.error(model.t('backup.savingFailed'))) }} className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1" style={{ backgroundColor: model.buddyConfig?.auto_push_enabled ? 'var(--color-brand-600, #6366f1)' : '#d1d5db' }}><span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${model.buddyConfig?.auto_push_enabled ? 'translate-x-4' : 'translate-x-0.5'}`} /></button><span className="text-sm text-zinc-700 dark:text-slate-300">{model.buddyConfig?.auto_push_enabled ? model.t('backup.enabled') : model.t('backup.disabled')}</span></div>{model.buddyConfig?.auto_push_enabled && <div className="space-y-3 pl-2 border-l-2 border-brand-200 dark:border-brand-800"><div className="flex items-center gap-3"><input id="backup-buddy-push-on-change" type="checkbox" checked={model.buddyConfig?.auto_push_on_change ?? false} onChange={e => { api.put('/api/v1/backup/buddy/auto', { enabled: true, interval_hours: model.buddyConfig?.auto_push_interval_hours ?? 24, on_change: e.target.checked, folder_ids: model.buddyConfig?.auto_push_folder_ids ?? [] }).then(() => ignorePromise(model.refetchBuddyConfig())).catch(() => toast.error(model.t('backup.savingFailed'))) }} className="h-4 w-4 rounded border-zinc-300 text-brand-600 focus:ring-brand-500" /><label htmlFor="backup-buddy-push-on-change" className="cursor-pointer"><p className="text-sm text-zinc-700 dark:text-slate-300">{model.t('backup.pushOnChange')}</p><p className="text-xs text-zinc-400 dark:text-slate-500">{model.t('backup.pushOnChangeDesc')}</p></label></div>{!model.buddyConfig?.auto_push_on_change && <div className="flex items-center gap-3"><label className="text-xs text-zinc-500 dark:text-slate-400 shrink-0">{model.t('backup.interval')}</label><select value={model.buddyConfig?.auto_push_interval_hours ?? 24} onChange={e => { api.put('/api/v1/backup/buddy/auto', { enabled: true, interval_hours: Number(e.target.value), on_change: false, folder_ids: model.buddyConfig?.auto_push_folder_ids ?? [] }).then(() => ignorePromise(model.refetchBuddyConfig())).catch(() => toast.error(model.t('backup.savingFailed'))) }} className="text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-transparent px-2 py-1 text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"><option value={1}>{model.t('backup.everyHour')}</option><option value={6}>{model.t('backup.every6Hours')}</option><option value={12}>{model.t('backup.every12Hours')}</option><option value={24}>{model.t('backup.daily')}</option><option value={48}>{model.t('backup.every2Days')}</option><option value={168}>{model.t('backup.weekly')}</option></select></div>}<div><p className="text-xs text-zinc-500 dark:text-slate-400 mb-1">{model.t('backup.foldersLabel')}</p><FolderPicker selectedIDs={model.buddyConfig?.auto_push_folder_ids ?? []} onChange={ids => { api.put('/api/v1/backup/buddy/auto', { enabled: true, interval_hours: model.buddyConfig?.auto_push_interval_hours ?? 24, on_change: model.buddyConfig?.auto_push_on_change ?? false, folder_ids: ids }).then(() => ignorePromise(model.refetchBuddyConfig())).catch(() => toast.error(model.t('backup.savingFailed'))) }} /></div>{model.buddyConfig?.auto_push_last_run_at && <p className="text-xs text-zinc-400 dark:text-slate-500 flex items-center gap-1"><Clock size={11} /> {model.t('backup.lastAutoAt', { when: new Date(model.buddyConfig.auto_push_last_run_at).toLocaleString() })}</p>}</div>}</div></section>
  )
}

function BackupBuddyArchivesSection({ model }: Readonly<{ model: any }>) {
  return (
    <>
      {model.buddyConfig?.peer_configured && (
        <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ArrowUpToLine size={16} className="text-brand-500" />
              <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{model.t('backup.pushedTitle')}</h2>
            </div>
            <button onClick={() => ignorePromise(model.refetchPushedArchives())} className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors text-zinc-400" title="Opdater liste">
              <RefreshCw size={13} />
            </button>
          </div>
          <p className="text-sm text-zinc-500 dark:text-slate-400">{model.t('backup.pushedDesc')}</p>
          {renderPushedArchivesContent(model.pushedArchives, model.deletePushedMutation.isPending, (filename) => {
            if (confirm(model.t('backup.confirmDeleteAtPeer'))) model.deletePushedMutation.mutate(filename)
          }, model.t)}
        </section>
      )}

      <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Server size={16} className="text-brand-500" />
          <h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{model.t('backup.receivedTitle')}</h2>
        </div>
        <p className="text-sm text-zinc-500 dark:text-slate-400">{model.t('backup.receivedDesc')}</p>
        {renderReceivedArchivesContent(model.buddyConfig?.has_receive_token ?? false, model.buddyReceived, (filename) => model.deleteBuddyMutation.mutate(filename), model.t)}
      </section>
    </>
  )
}

function BackupBuddyTabContent({ model }: Readonly<{ model: any }>) {
  if (!model.hasToken) return <BackupTokenRequiredNotice t={model.t} />
  return <div className="space-y-8"><BackupBuddyOverviewSection model={model} /><BackupBuddyConfigSection model={model} /><BackupBuddyQuotaSection model={model} /><BackupBuddyPushSection model={model} /><BackupBuddyAutoPushSection model={model} /><BackupBuddyArchivesSection model={model} /></div>
}

function BackupTokenTabContent({ model }: Readonly<{ model: any }>) {
  return <section className="rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] p-5 space-y-4"><div className="flex items-center gap-2"><ShieldCheck size={16} className="text-brand-500" /><h2 className="font-medium text-zinc-900 dark:text-slate-100 text-sm">{model.t('backup.tokenTitle')}</h2></div><p className="text-sm text-zinc-500 dark:text-slate-400">{model.t('backup.tokenDesc')}</p>{renderTokenStatusContent({ isLoading: model.isLoading, status: model.status, generatePending: model.generateMutation.isPending, revokePending: model.revokeMutation.isPending, onRotate: () => { if (confirm(model.t('backup.rotateTokenConfirm'))) model.generateMutation.mutate() }, onRevoke: () => { if (confirm(model.t('backup.revokeTokenConfirm'))) model.revokeMutation.mutate() }, onGenerate: () => model.generateMutation.mutate(), t: model.t })}{model.newToken && <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-4 space-y-2"><div className="flex items-start gap-2 text-amber-700 dark:text-amber-400"><AlertTriangle size={16} className="mt-0.5 shrink-0" /><p className="text-sm font-medium">{model.t('backup.tokenSaveNow')}</p></div><div className="flex items-center gap-2"><code className="flex-1 text-xs font-mono bg-white dark:bg-[#0f1117] border border-amber-200 dark:border-amber-800 rounded px-3 py-2 break-all text-zinc-800 dark:text-slate-200 select-all">{model.newToken}</code><button onClick={model.handleCopyToken} className="shrink-0 p-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors" title="Copy token">{model.tokenCopied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}</button></div></div>}</section>
}

function BackupPageContent({ model }: Readonly<{ model: any }>) {
  return <div className="max-w-2xl space-y-6"><div><h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100 flex items-center gap-2"><Archive size={20} />{model.t('backup.title')}</h1><p className="mt-1 text-sm text-zinc-500 dark:text-slate-400">{model.t('backup.description')}</p></div><BackupPageTabs model={model} />{model.activeTab === 'storage' && <BackupStorageTabContent model={model} />}{model.activeTab === 'buddy' && <BackupBuddyTabContent model={model} />}{model.activeTab === 'token' && <BackupTokenTabContent model={model} />}</div>
}
function getFileTreeRowClass(isChecked: boolean, isIndeterminate: boolean): string {
  if (isChecked) return 'bg-brand-50 dark:bg-brand-900/20'
  if (isIndeterminate) return 'bg-brand-50/40 dark:bg-brand-900/10'
  return 'hover:bg-zinc-100 dark:hover:bg-[#2d3148]/50'
}

function getFileTreeItemIcon(isFolder: boolean, isChecked: boolean, isIndeterminate: boolean) {
  if (isFolder) {
    return <Folder size={12} className={isChecked || isIndeterminate ? 'text-brand-500 shrink-0' : 'text-zinc-400 shrink-0'} />
  }

  return <FileIcon size={12} className={isChecked ? 'text-brand-400 shrink-0' : 'text-zinc-400 shrink-0'} />
}

function getFileTreeNameClass(isChecked: boolean, isIndeterminate: boolean): string {
  if (isChecked) return 'text-brand-700 dark:text-brand-300 font-medium'
  if (isIndeterminate) return 'text-brand-600/70 dark:text-brand-400/70'
  return 'text-zinc-700 dark:text-slate-300'
}

function getFileTreeChildrenContent({
  expanded,
  isFolder,
  loadingChildren,
  children,
  depth,
  t,
  selectedIDs,
  onToggle,
  ancestorIDs,
  allChecked,
  ancestorIDForChildren,
}: Readonly<{
  expanded: boolean
  isFolder: boolean
  loadingChildren: boolean
  children: FileItem[] | undefined
  depth: number
  t: TranslateFn
  selectedIDs: string[]
  onToggle: (id: string, nearestAncestorID?: string) => void
  ancestorIDs: Set<string>
  allChecked: boolean
  ancestorIDForChildren?: string
}>) {
  if (!expanded || !isFolder) return null

  if (loadingChildren) {
    return (
      <p className="text-xs text-zinc-400 py-0.5" style={{ paddingLeft: `${(depth + 1) * 14 + 20}px` }}>
        {t('backup.pickerLoading')}
      </p>
    )
  }

  return (children ?? []).map(child => (
    <FileTreeNode
      key={child.id}
      item={child}
      depth={depth + 1}
      selectedIDs={selectedIDs}
      onToggle={onToggle}
      ancestorIDs={ancestorIDs}
      allChecked={allChecked}
      nearestSelectedAncestorID={ancestorIDForChildren}
    />
  ))
}

function getFileTreeLabelClass(isExplicit: boolean, inheritedSelected: boolean, isIndeterminate: boolean): string {
  if (isExplicit) return 'bg-brand-600 border-brand-600'
  if (inheritedSelected) return 'bg-brand-400 border-brand-400'
  if (isIndeterminate) return 'bg-brand-400/30 border-brand-400'
  return 'border-zinc-300 dark:border-[#4a5070] bg-white dark:bg-[#1a1d27]'
}

function getFolderPickerSelectionLabel(allChecked: boolean, manualMode: boolean, selectedCount: number, t: TranslateFn): string {
  if (allChecked) return t('backup.allFiles')
  if (manualMode && selectedCount === 0) return t('backup.nothingSelected')
  return t('backup.nItemsSelected', { count: selectedCount })
}

function getBackupTabClass(isActive: boolean, hasToken: boolean): string {
  if (isActive) return 'border-brand-500 text-brand-600 dark:text-brand-400'
  if (!hasToken) return 'border-transparent text-zinc-300 dark:text-slate-600 cursor-not-allowed'
  return 'border-transparent text-zinc-500 dark:text-slate-400 hover:text-zinc-700 dark:hover:text-slate-200 cursor-pointer'
}

function getArchiveCountLabel(count: number, t: TranslateFn): string {
  return `${count} ${count !== 1 ? t('backup.archives') : t('backup.archive')}`
}

function renderPushedArchiveSummary(
  peerConfigured: boolean,
  pushedArchives: BuddyArchive[] | undefined,
  lastPushAt: string | null | undefined,
  lastPushBytes: number,
  t: TranslateFn,
) {
  if (peerConfigured && pushedArchives && pushedArchives.length > 0) {
    return (
      <>
        <p className="text-lg font-semibold text-zinc-900 dark:text-slate-100">
          {formatBytes(pushedArchives.reduce((sum, archive) => sum + archive.size_bytes, 0))}
        </p>
        <p className="text-xs text-zinc-400">{getArchiveCountLabel(pushedArchives.length, t)}</p>
      </>
    )
  }

  if (peerConfigured && lastPushAt) {
    return (
      <>
        <p className="text-lg font-semibold text-zinc-900 dark:text-slate-100">
          {formatBytes(lastPushBytes)}
        </p>
        <p className="text-xs text-zinc-400">
          {t('backup.lastAutoAt', { when: new Date(lastPushAt).toLocaleDateString() })}
        </p>
      </>
    )
  }

  return <p className="text-sm text-zinc-400 dark:text-slate-500">{t('backup.noArchivesYet')}</p>
}

function renderTunnelStatusContent(
  tunnelStatus: BuddyTunnelStatus | undefined,
  connectPending: boolean,
  disconnectPending: boolean,
  onConnect: () => void,
  onDisconnect: () => void,
  t: TranslateFn,
) {
  if (tunnelStatus?.connected_to_peer) {
    return (
      <>
        <p className="text-sm font-semibold text-green-600 dark:text-green-400 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
          {t('backup.tunnelActive')}
        </p>
        {!tunnelStatus.peer_connected_here && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">{t('backup.tunnelWrongDirection')}</p>
        )}
        <button
          onClick={onDisconnect}
          disabled={disconnectPending}
          className="text-xs text-red-500 hover:text-red-600 dark:hover:text-red-400 transition-colors"
        >
          {t('backup.tunnelDisconnect')}
        </button>
      </>
    )
  }

  if (tunnelStatus?.peer_connected_here) {
    return (
      <>
        <p className="text-sm font-semibold text-blue-600 dark:text-blue-400 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
          {t('backup.tunnelPeerConnected')}
        </p>
        <p className="text-xs text-zinc-400">{t('backup.tunnelPeerConnectedDesc')}</p>
      </>
    )
  }

  return (
    <>
      <p className="text-sm text-zinc-400 dark:text-slate-500">{t('backup.tunnelInactive')}</p>
      <button
        onClick={onConnect}
        disabled={connectPending}
        className="text-xs text-brand-600 dark:text-brand-400 hover:underline transition-colors flex items-center gap-1"
      >
        {connectPending && <RefreshCw size={10} className="animate-spin" />}
        {t('backup.tunnelActivateCgnat')}
      </button>
    </>
  )
}

function renderPushedArchivesContent(
  pushedArchives: BuddyArchive[] | undefined,
  deletePending: boolean,
  onDelete: (filename: string) => void,
  t: TranslateFn,
) {
  if (pushedArchives && pushedArchives.length > 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-slate-400 pb-1 border-b border-zinc-100 dark:border-[#2d3148]">
          <span>{getArchiveCountLabel(pushedArchives.length, t)}</span>
          <span className="font-medium">{formatBytes(pushedArchives.reduce((sum, archive) => sum + archive.size_bytes, 0))} total</span>
        </div>
        <div className="space-y-1">
          {pushedArchives.map(archive => (
            <div
              key={archive.filename}
              className="flex items-center gap-2 rounded-lg border border-zinc-100 dark:border-[#2d3148] px-3 py-2 text-xs"
            >
              <span className="flex-1 font-mono text-zinc-700 dark:text-slate-300 truncate">{archive.filename}</span>
              <span className="text-zinc-400 shrink-0">{formatBytes(archive.size_bytes)}</span>
              <span className="text-zinc-400 shrink-0">{new Date(archive.received_at).toLocaleDateString()}</span>
              <button
                onClick={() => onDelete(archive.filename)}
                disabled={deletePending}
                className="shrink-0 p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors disabled:opacity-50"
                title={t('backup.deleteAtPeer')}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (pushedArchives) {
    return <p className="text-xs text-zinc-400">{t('backup.noPushed')}</p>
  }

  return <p className="text-xs text-zinc-400">{t('backup.fetchFromPeer')}</p>
}

function renderReceivedArchivesContent(
  hasReceiveToken: boolean,
  buddyReceived: BuddyArchive[] | undefined,
  onDelete: (filename: string) => void,
  t: TranslateFn,
) {
  if (!hasReceiveToken) {
    return <p className="text-xs text-zinc-400 dark:text-slate-500">{t('backup.receiveTokenNeeded')}</p>
  }

  if (buddyReceived && buddyReceived.length > 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-slate-400 pb-1 border-b border-zinc-100 dark:border-[#2d3148]">
          <span>{getArchiveCountLabel(buddyReceived.length, t)}</span>
          <span className="font-medium">{formatBytes(buddyReceived.reduce((sum, archive) => sum + archive.size_bytes, 0))} total</span>
        </div>
        <div className="space-y-1">
          {buddyReceived.map(archive => (
            <div
              key={archive.filename}
              className="flex items-center gap-2 rounded-lg border border-zinc-100 dark:border-[#2d3148] px-3 py-2 text-xs"
            >
              <span className="flex-1 font-mono text-zinc-700 dark:text-slate-300 truncate">{archive.filename}</span>
              <span className="text-zinc-400 shrink-0">{formatBytes(archive.size_bytes)}</span>
              <span className="text-zinc-400 shrink-0">{new Date(archive.received_at).toLocaleDateString()}</span>
              <a
                href={`/api/v1/backup/buddy/received/${encodeURIComponent(archive.filename)}`}
                download={archive.filename}
                className="shrink-0 p-1 rounded hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors"
                title="Download"
              >
                <Download size={12} />
              </a>
              <button
                onClick={() => onDelete(archive.filename)}
                className="shrink-0 p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                title="Delete"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return <p className="text-xs text-zinc-400">{t('backup.noReceived')}</p>
}

function renderTokenStatusContent({
  isLoading,
  status,
  generatePending,
  revokePending,
  onRotate,
  onRevoke,
  onGenerate,
  t,
}: Readonly<{
  isLoading: boolean
  status: BackupPasswordStatus | undefined
  generatePending: boolean
  revokePending: boolean
  onRotate: () => void
  onRevoke: () => void
  onGenerate: () => void
  t: TranslateFn
}>) {
  if (isLoading) {
    return <p className="text-sm text-zinc-400">{t('backup.tokenLoading')}</p>
  }

  if (status?.has_password) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-zinc-600 dark:text-slate-400">
          {t('backup.tokenActive')}
          {status.created_at && <> Created {new Date(status.created_at).toLocaleDateString()}.</>}
          {status.last_used_at && <> Last used {new Date(status.last_used_at).toLocaleDateString()}.</>}
        </p>
        <div className="flex gap-2">
          <button
            onClick={onRotate}
            disabled={generatePending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-200 dark:border-[#2d3148] text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} /> {t('backup.tokenRotate')}
          </button>
          <button
            onClick={onRevoke}
            disabled={revokePending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
          >
            <Trash2 size={12} /> {t('backup.tokenRevoke')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500 dark:text-slate-400">{t('backup.tokenNone')}</p>
      <button
        onClick={onGenerate}
        disabled={generatePending}
        className="px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white transition-colors disabled:opacity-50"
      >
        {t('backup.tokenGenerate')}
      </button>
    </div>
  )
}




















