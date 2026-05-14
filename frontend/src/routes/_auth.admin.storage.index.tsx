import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { formatBytes, formatRelative } from '@/lib/utils'
import { AlertTriangle, ChevronDown, Clock, Eye, FileQuestion, FolderInput, Loader2, ScanSearch, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { PreviewModal } from '@/components/files/PreviewModal'
import type { FileItem } from '@/types/api'
import { useI18n } from '@/lib/i18n'

export const Route = createFileRoute('/_auth/admin/storage/')({
  component: StoragePage,
})

interface CorruptFile {
  id: string
  name: string
  owner_id: string
  owner_name: string
  size_bytes: number
  mime_type: string
  reason?: string
  updated_at: string
}

interface ScanResult {
  scanned_files: number
  corrupt_files: CorruptFile[]
  duration_ms: number
}

interface OrphanFile {
  id: string
  path: string
  size_bytes: number
  mod_time: string
}

interface OrphanScanResult {
  scanned_blobs: number
  orphan_files: OrphanFile[]
  duration_ms: number
}

interface ScanScheduleConfig {
  enabled: boolean
  interval: 'hourly' | 'daily' | 'weekly' | 'monthly'
  hour: number
  day_of_week: number
  day_of_month: number
}

interface ScanScheduleData {
  corrupt: ScanScheduleConfig
  orphan: ScanScheduleConfig
  corrupt_last_run: string
  orphan_last_run: string
}

const SCAN_KEY     = ['admin', 'storage-scan']
const ORPHAN_KEY   = ['admin', 'storage-orphans']
const SCHEDULE_KEY = ['admin', 'storage-schedule']

const DEFAULT_SCHED: ScanScheduleConfig = {
  enabled: false, interval: 'daily', hour: 2, day_of_week: 1, day_of_month: 1,
}

function scheduleLabel(cfg: ScanScheduleConfig): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const h = String(cfg.hour).padStart(2, '0') + ':00 UTC'
  switch (cfg.interval) {
    case 'hourly':  return 'Every hour'
    case 'daily':   return `Daily at ${h}`
    case 'weekly':  return `${days[cfg.day_of_week]} at ${h}`
    case 'monthly': return `Day ${cfg.day_of_month} at ${h}`
    default:        return cfg.interval
  }
}

function corruptToFileItem(f: CorruptFile): FileItem {
  return {
    id: f.id,
    parent_id: null,
    owner_id: f.owner_id,
    is_folder: false,
    name: f.name,
    mime_type: f.mime_type || null,
    size_bytes: f.size_bytes,
    checksum_sha256: null,
    deleted_at: null,
    created_at: f.updated_at,
    updated_at: f.updated_at,
  }
}

function StoragePage() {
  const queryClient = useQueryClient()
  const [previewCorrupt, setPreviewCorrupt] = useState<CorruptFile | null>(null)
  const { t } = useI18n()

  // -- Corrupt file scan
  const [selectedCorrupt, setSelectedCorrupt] = useState<Set<string>>(new Set())

  const { data: scanResult, isFetching: scanFetching, refetch: refetchScan } = useQuery<ScanResult>({
    queryKey: SCAN_KEY,
    queryFn: () => api.post<ScanResult>('/api/v1/admin/storage/scan'),
    enabled: false,
    staleTime: Infinity,
  })

  const startScan = async () => {
    setSelectedCorrupt(new Set())
    const result = await refetchScan()
    if (result.data) {
      if (result.data.corrupt_files.length === 0) {
        toast.success(t('storage.scanComplete', { n: String(result.data.scanned_files) }))
      } else {
        toast.warning(t('storage.corruptFound', { corrupt: String(result.data.corrupt_files.length), n: String(result.data.scanned_files) }))
      }
    } else if (result.error) {
      toast.error(t('storage.scanFailed'))
    }
  }

  const purgeCorrupt = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ deleted: number; disk_deleted: number }>('/api/v1/admin/storage/purge-corrupt', { ids }),
    onSuccess: (data, ids) => {
      toast.success(t('storage.purged', { records: String(data.deleted), files: String(data.disk_deleted) }))
      queryClient.setQueryData<ScanResult>(SCAN_KEY, prev =>
        prev ? { ...prev, corrupt_files: prev.corrupt_files.filter(f => !ids.includes(f.id)) } : prev
      )
      setSelectedCorrupt(new Set())
    },
    onError: () => toast.error(t('storage.purgeFailed')),
  })

  const toggleAllCorrupt = () => {
    if (!scanResult) return
    setSelectedCorrupt(prev =>
      prev.size === scanResult.corrupt_files.length
        ? new Set()
        : new Set(scanResult.corrupt_files.map(f => f.id))
    )
  }

  // -- Orphan file scan
  const [selectedOrphan, setSelectedOrphan] = useState<Set<string>>(new Set())

  const { data: orphanResult, isFetching: orphanFetching, refetch: refetchOrphans } = useQuery<OrphanScanResult>({
    queryKey: ORPHAN_KEY,
    queryFn: () => api.post<OrphanScanResult>('/api/v1/admin/storage/scan-orphans'),
    enabled: false,
    staleTime: Infinity,
  })

  const startOrphanScan = async () => {
    setSelectedOrphan(new Set())
    const result = await refetchOrphans()
    if (result.data) {
      if (result.data.orphan_files.length === 0) {
        toast.success(t('storage.orphanScanComplete', { n: String(result.data.scanned_blobs) }))
      } else {
        toast.warning(t('storage.orphansFound', { orphans: String(result.data.orphan_files.length), n: String(result.data.scanned_blobs) }))
      }
    } else if (result.error) {
      toast.error(t('storage.orphanScanFailed'))
    }
  }

  const purgeOrphans = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ deleted: number; freed_bytes: number }>('/api/v1/admin/storage/purge-orphans', { ids }),
    onSuccess: (data, ids) => {
      toast.success(t('storage.orphansPurged', { n: String(data.deleted), bytes: formatBytes(data.freed_bytes) }))
      queryClient.setQueryData<OrphanScanResult>(ORPHAN_KEY, prev =>
        prev ? { ...prev, orphan_files: prev.orphan_files.filter(f => !ids.includes(f.id)) } : prev
      )
      setSelectedOrphan(new Set())
    },
    onError: () => toast.error(t('storage.orphanPurgeFailed')),
  })

  const restoreOrphans = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ restored: number; skipped: number; folder_id: string }>('/api/v1/admin/storage/restore-orphans', { ids }),
    onSuccess: (data, ids) => {
      toast.success(t('storage.orphansRestored', { n: String(data.restored) }))
      queryClient.setQueryData<OrphanScanResult>(ORPHAN_KEY, prev =>
        prev ? { ...prev, orphan_files: prev.orphan_files.filter(f => !ids.includes(f.id)) } : prev
      )
      setSelectedOrphan(new Set())
    },
    onError: () => toast.error(t('storage.restoreFailed')),
  })

  const toggleAllOrphans = () => {
    if (!orphanResult) return
    setSelectedOrphan(prev =>
      prev.size === orphanResult.orphan_files.length
        ? new Set()
        : new Set(orphanResult.orphan_files.map(f => f.id))
    )
  }

  // -- Schedule
  const { data: scheduleData } = useQuery<ScanScheduleData>({
    queryKey: SCHEDULE_KEY,
    queryFn: () => api.get<ScanScheduleData>('/api/v1/admin/storage/schedule'),
  })

  const [draftCorrupt, setDraftCorrupt] = useState<ScanScheduleConfig>(DEFAULT_SCHED)
  const [draftOrphan,  setDraftOrphan]  = useState<ScanScheduleConfig>({ ...DEFAULT_SCHED, hour: 3 })
  const [scheduleSynced, setScheduleSynced] = useState(false)

  useEffect(() => {
    if (scheduleData && !scheduleSynced) {
      setDraftCorrupt(scheduleData.corrupt)
      setDraftOrphan(scheduleData.orphan)
      setScheduleSynced(true)
    }
  }, [scheduleData, scheduleSynced])

  const saveSchedule = useMutation({
    mutationFn: (which: 'corrupt' | 'orphan') =>
      api.put<{ ok: boolean }>('/api/v1/admin/storage/schedule', {
        corrupt: which === 'corrupt' ? draftCorrupt : (scheduleData?.corrupt ?? draftCorrupt),
        orphan:  which === 'orphan'  ? draftOrphan  : (scheduleData?.orphan  ?? draftOrphan),
      }),
    onSuccess: () => {
      toast.success(t('storage.scheduleSaved'))
      queryClient.invalidateQueries({ queryKey: SCHEDULE_KEY })
      setScheduleSynced(false)
    },
    onError: () => toast.error(t('storage.scheduleFailed')),
  })

  // -- Render
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">{t('storage.title')}</h1>

      {/* Corrupt file scan */}
      <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">Corrupt file scan</h2>
        <p className="text-sm text-muted">
          Scans all binary files (images, PDFs, Office documents, archives, etc.) using two
          checks: (1) reads 512 bytes to detect HTML error pages saved as binary files; (2) for
          JPEG/PNG/GIF/WebP, parses the full image header to catch files with valid magic bytes
          but corrupt data after them.
        </p>
        <button
          onClick={startScan}
          disabled={scanFetching}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {scanFetching ? <Loader2 size={15} className="animate-spin" /> : <ScanSearch size={15} />}
          {scanFetching ? 'Scanning...' : 'Scan for corrupt files'}
        </button>
        {scanFetching && (
          <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <Loader2 size={14} className="animate-spin" />
            <span>Scanning files - this may take a moment...</span>
          </div>
        )}
        {scanResult && !scanFetching && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Scanned {scanResult.scanned_files} files in {scanResult.duration_ms} ms
          </p>
        )}
        <SchedulePanel
          value={draftCorrupt}
          onChange={setDraftCorrupt}
          onSave={() => saveSchedule.mutate('corrupt')}
          isSaving={saveSchedule.isPending}
          lastRun={scheduleData?.corrupt_last_run ?? ''}
        />
      </section>

      {scanResult && !scanFetching && scanResult.corrupt_files.length > 0 && (
        <FileTable
          icon={<AlertTriangle size={15} className="text-amber-500" />}
          title={`${scanResult.corrupt_files.length} corrupt file(s) found`}
          selected={selectedCorrupt}
          onToggleAll={toggleAllCorrupt}
          onToggle={id => setSelectedCorrupt(prev => toggle(prev, id))}
          onDelete={() => purgeCorrupt.mutate(Array.from(selectedCorrupt))}
          isDeleting={purgeCorrupt.isPending}
          onPreview={id => setPreviewCorrupt(scanResult.corrupt_files.find(f => f.id === id) ?? null)}
          rows={scanResult.corrupt_files.map(f => ({
            id: f.id,
            col1: f.name,
            col1Title: f.name,
            col2: f.owner_name || f.owner_id.slice(0, 8),
            col2Title: f.owner_name,
            col3: f.reason ?? '',
            col4: formatRelative(f.updated_at),
          }))}
          headers={['Name', 'Owner', 'Reason', 'Modified']}
        />
      )}
      {scanResult && !scanFetching && scanResult.corrupt_files.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <span>checkmark</span> No corrupt files found.
        </p>
      )}

      {/* Orphan file scan */}
      <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">Orphan file scan</h2>
        <p className="text-sm text-muted">
          Walks the physical storage directory and finds blobs that have no matching record in the
          database. These can be safely deleted to free disk space, or restored to a folder for review.
        </p>
        <button
          onClick={startOrphanScan}
          disabled={orphanFetching}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {orphanFetching ? <Loader2 size={15} className="animate-spin" /> : <FileQuestion size={15} />}
          {orphanFetching ? 'Scanning...' : 'Scan for orphan files'}
        </button>
        {orphanFetching && (
          <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <Loader2 size={14} className="animate-spin" />
            <span>Walking storage directory - this may take a moment...</span>
          </div>
        )}
        {orphanResult && !orphanFetching && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Scanned {orphanResult.scanned_blobs} blobs in {orphanResult.duration_ms} ms
          </p>
        )}
        <SchedulePanel
          value={draftOrphan}
          onChange={setDraftOrphan}
          onSave={() => saveSchedule.mutate('orphan')}
          isSaving={saveSchedule.isPending}
          lastRun={scheduleData?.orphan_last_run ?? ''}
        />
      </section>

      {orphanResult && !orphanFetching && orphanResult.orphan_files.length > 0 && (
        <FileTable
          icon={<FileQuestion size={15} className="text-blue-500" />}
          title={`${orphanResult.orphan_files.length} orphan file(s) found`}
          selected={selectedOrphan}
          onToggleAll={toggleAllOrphans}
          onToggle={id => setSelectedOrphan(prev => toggle(prev, id))}
          onDelete={() => purgeOrphans.mutate(Array.from(selectedOrphan))}
          isDeleting={purgeOrphans.isPending}
          extraActions={
            <button
              onClick={() => restoreOrphans.mutate(Array.from(selectedOrphan))}
              disabled={restoreOrphans.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-xs font-medium transition-colors"
            >
              <FolderInput size={13} />
              {restoreOrphans.isPending ? 'Restoring...' : `Restore ${selectedOrphan.size} selected`}
            </button>
          }
          rows={orphanResult.orphan_files.map(f => ({
            id: f.id,
            col1: f.path,
            col1Title: f.path,
            col2: '/',
            col2Title: '',
            col3: formatBytes(f.size_bytes),
            col4: formatRelative(f.mod_time),
          }))}
          headers={['Path', 'Owner', 'Size', 'Modified']}
        />
      )}
      {orphanResult && !orphanFetching && orphanResult.orphan_files.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <span>checkmark</span> No orphan files found.
        </p>
      )}

      {previewCorrupt && (
        <PreviewModal
          item={corruptToFileItem(previewCorrupt)}
          onClose={() => setPreviewCorrupt(null)}
          onDelete={item => {
            purgeCorrupt.mutate([item.id])
            setPreviewCorrupt(null)
          }}
        />
      )}
    </div>
  )
}

// -- Schedule panel

function SchedulePanel({ value, onChange, onSave, isSaving, lastRun }: {
  value: ScanScheduleConfig
  onChange: (v: ScanScheduleConfig) => void
  onSave: () => void
  isSaving: boolean
  lastRun: string
}) {
  const [open, setOpen] = useState(false)
  const sel = 'text-xs px-2 py-1 rounded border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1e2130] text-zinc-700 dark:text-slate-300'

  return (
    <div className="border border-zinc-200 dark:border-[#2d3148] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-zinc-500 dark:text-slate-400 hover:bg-zinc-50 dark:hover:bg-[#1e2130] transition-colors"
      >
        <div className="flex items-center gap-1.5">
          <Clock size={12} />
          <span className="font-medium">Scheduled scan</span>
          {value.enabled && (
            <span className="px-1.5 py-0.5 bg-brand-50 dark:bg-brand-900/30 text-brand-700 dark:text-brand-400 rounded text-[10px] font-medium">
              {scheduleLabel(value)}
            </span>
          )}
        </div>
        <ChevronDown size={12} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>

      {open && (
        <div className="px-3 pb-3 pt-2 space-y-3 border-t border-zinc-100 dark:border-[#2d3148]">
          {lastRun ? (
            <p className="text-[11px] text-zinc-400">Last run: {formatRelative(lastRun)}</p>
          ) : value.enabled ? (
            <p className="text-[11px] text-zinc-400">Never run yet</p>
          ) : null}

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={e => onChange({ ...value, enabled: e.target.checked })}
              className="rounded"
            />
            <span className="text-xs text-zinc-700 dark:text-slate-300">Enable automatic scheduled scan</span>
          </label>

          {value.enabled && (
            <div className="flex flex-wrap gap-2 items-end">
              <div>
                <p className="text-[10px] text-zinc-400 mb-0.5">Interval</p>
                <select
                  value={value.interval}
                  onChange={e => onChange({ ...value, interval: e.target.value as ScanScheduleConfig['interval'] })}
                  className={sel}
                >
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
              {value.interval !== 'hourly' && (
                <div>
                  <p className="text-[10px] text-zinc-400 mb-0.5">Hour (UTC)</p>
                  <select
                    value={value.hour}
                    onChange={e => onChange({ ...value, hour: +e.target.value })}
                    className={sel}
                  >
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
                    ))}
                  </select>
                </div>
              )}
              {value.interval === 'weekly' && (
                <div>
                  <p className="text-[10px] text-zinc-400 mb-0.5">Day</p>
                  <select
                    value={value.day_of_week}
                    onChange={e => onChange({ ...value, day_of_week: +e.target.value })}
                    className={sel}
                  >
                    {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d, i) => (
                      <option key={i} value={i}>{d}</option>
                    ))}
                  </select>
                </div>
              )}
              {value.interval === 'monthly' && (
                <div>
                  <p className="text-[10px] text-zinc-400 mb-0.5">Day of month</p>
                  <select
                    value={value.day_of_month}
                    onChange={e => onChange({ ...value, day_of_month: +e.target.value })}
                    className={sel}
                  >
                    {Array.from({ length: 28 }, (_, i) => (
                      <option key={i + 1} value={i + 1}>{i + 1}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          <button
            onClick={onSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-xs font-medium transition-colors"
          >
            {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Clock size={12} />}
            {isSaving ? 'Saving...' : 'Save schedule'}
          </button>
        </div>
      )}
    </div>
  )
}

// -- Shared table component

function toggle(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

interface TableRow {
  id: string
  col1: string
  col1Title: string
  col2: string
  col2Title: string
  col3: string
  col4: string
}

function FileTable({
  icon, title, selected, onToggleAll, onToggle, onDelete, isDeleting, rows, headers, extraActions, onPreview,
}: {
  icon: React.ReactNode
  title: string
  selected: Set<string>
  onToggleAll: () => void
  onToggle: (id: string) => void
  onDelete: () => void
  isDeleting: boolean
  rows: TableRow[]
  headers: [string, string, string, string]
  extraActions?: React.ReactNode
  onPreview?: (id: string) => void
}) {
  return (
    <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-[#2d3148]">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-sm font-semibold text-zinc-900 dark:text-slate-100">{title}</span>
        </div>
        {selected.size > 0 && (
          <div className="flex items-center gap-2">
            {extraActions}
            <button
              onClick={onDelete}
              disabled={isDeleting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-medium transition-colors"
            >
              <Trash2 size={13} />
              {isDeleting ? 'Deleting...' : `Delete ${selected.size} selected`}
            </button>
          </div>
        )}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-zinc-400 dark:text-zinc-500 border-b border-zinc-100 dark:border-[#2d3148]">
            <th className="px-4 py-2 text-left w-8">
              <input type="checkbox" checked={selected.size === rows.length} onChange={onToggleAll} className="rounded" />
            </th>
            <th className="px-4 py-2 text-left">{headers[0]}</th>
            <th className="px-4 py-2 text-left">{headers[1]}</th>
            <th className="px-4 py-2 text-left">{headers[2]}</th>
            <th className="px-4 py-2 text-left">{headers[3]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id} className="border-b border-zinc-50 dark:border-[#1e2130] hover:bg-zinc-50 dark:hover:bg-[#1e2130]">
              <td className="px-4 py-2">
                <input type="checkbox" checked={selected.has(row.id)} onChange={() => onToggle(row.id)} className="rounded" />
              </td>
              <td className="px-4 py-2 font-medium text-zinc-800 dark:text-slate-200 truncate max-w-xs" title={row.col1Title}>
                {onPreview ? (
                  <button
                    onClick={() => onPreview(row.id)}
                    className="flex items-center gap-1.5 text-left hover:text-brand-500 transition-colors group"
                  >
                    <Eye size={13} className="shrink-0 text-zinc-400 group-hover:text-brand-500 transition-colors" />
                    <span className="truncate">{row.col1}</span>
                  </button>
                ) : row.col1}
              </td>
              <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400 truncate max-w-[160px]" title={row.col2Title}>
                {row.col2}
              </td>
              <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400 whitespace-nowrap">{row.col3}</td>
              <td className="px-4 py-2 text-zinc-400 dark:text-zinc-500 whitespace-nowrap">{row.col4}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}