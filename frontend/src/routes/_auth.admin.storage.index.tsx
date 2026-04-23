import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import { formatBytes, formatRelative } from '@/lib/utils'
import { AlertTriangle, FileQuestion, Loader2, ScanSearch, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

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

const SCAN_KEY = ['admin', 'storage-scan']
const ORPHAN_KEY = ['admin', 'storage-orphans']

function StoragePage() {
  const queryClient = useQueryClient()

  // ── Corrupt file scan ──────────────────────────────────────────────────────
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
        toast.success(`Scan complete — no corrupt files found (${result.data.scanned_files} scanned)`)
      } else {
        toast.warning(`Found ${result.data.corrupt_files.length} corrupt file(s) out of ${result.data.scanned_files} scanned`)
      }
    } else if (result.error) {
      toast.error('Scan failed')
    }
  }

  const purgeCorrupt = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ deleted: number; disk_deleted: number }>('/api/v1/admin/storage/purge-corrupt', { ids }),
    onSuccess: (data, ids) => {
      toast.success(`${data.deleted} record(s) removed — ${data.disk_deleted} file(s) deleted from disk`)
      queryClient.setQueryData<ScanResult>(SCAN_KEY, prev =>
        prev ? { ...prev, corrupt_files: prev.corrupt_files.filter(f => !ids.includes(f.id)) } : prev
      )
      setSelectedCorrupt(new Set())
    },
    onError: () => toast.error('Purge failed'),
  })

  const toggleAllCorrupt = () => {
    if (!scanResult) return
    setSelectedCorrupt(prev =>
      prev.size === scanResult.corrupt_files.length
        ? new Set()
        : new Set(scanResult.corrupt_files.map(f => f.id))
    )
  }

  // ── Orphan file scan ───────────────────────────────────────────────────────
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
        toast.success(`Scan complete — no orphan files found (${result.data.scanned_blobs} blobs scanned)`)
      } else {
        toast.warning(`Found ${result.data.orphan_files.length} orphan file(s) out of ${result.data.scanned_blobs} scanned`)
      }
    } else if (result.error) {
      toast.error('Orphan scan failed')
    }
  }

  const purgeOrphans = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ deleted: number; freed_bytes: number }>('/api/v1/admin/storage/purge-orphans', { ids }),
    onSuccess: (data, ids) => {
      toast.success(`${data.deleted} file(s) deleted — ${formatBytes(data.freed_bytes)} freed`)
      queryClient.setQueryData<OrphanScanResult>(ORPHAN_KEY, prev =>
        prev ? { ...prev, orphan_files: prev.orphan_files.filter(f => !ids.includes(f.id)) } : prev
      )
      setSelectedOrphan(new Set())
    },
    onError: () => toast.error('Purge failed'),
  })

  const toggleAllOrphans = () => {
    if (!orphanResult) return
    setSelectedOrphan(prev =>
      prev.size === orphanResult.orphan_files.length
        ? new Set()
        : new Set(orphanResult.orphan_files.map(f => f.id))
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">Storage</h1>

      {/* ── Corrupt file scan ── */}
      <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">Corrupt file scan</h2>
        <p className="text-sm text-muted">
          Scans image files on disk and detects entries where the file content is an HTML/text
          error page instead of a valid image — a common result of failed WebDAV migrations from
          Nextcloud or similar systems.
        </p>
        <button
          onClick={startScan}
          disabled={scanFetching}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {scanFetching ? <Loader2 size={15} className="animate-spin" /> : <ScanSearch size={15} />}
          {scanFetching ? 'Scanning…' : 'Scan for corrupt files'}
        </button>
        {scanFetching && (
          <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <Loader2 size={14} className="animate-spin" />
            <span>Reading file magic bytes — this may take a moment…</span>
          </div>
        )}
        {scanResult && !scanFetching && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Scanned {scanResult.scanned_files} files in {scanResult.duration_ms} ms
          </p>
        )}
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
          rows={scanResult.corrupt_files.map(f => ({
            id: f.id,
            col1: f.name,
            col1Title: f.name,
            col2: f.owner_name || f.owner_id.slice(0, 8),
            col2Title: f.owner_name,
            col3: formatBytes(f.size_bytes),
            col4: formatRelative(f.updated_at),
          }))}
          headers={['Name', 'Owner', 'Size', 'Modified']}
        />
      )}
      {scanResult && !scanFetching && scanResult.corrupt_files.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <span>✓</span> No corrupt files found.
        </p>
      )}

      {/* ── Orphan file scan ── */}
      <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">Orphan file scan</h2>
        <p className="text-sm text-muted">
          Walks the physical storage directory and finds blobs that have no matching record in the
          database — files that were never properly registered or whose DB entry was removed.
          These can be safely deleted to free disk space.
        </p>
        <button
          onClick={startOrphanScan}
          disabled={orphanFetching}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {orphanFetching ? <Loader2 size={15} className="animate-spin" /> : <FileQuestion size={15} />}
          {orphanFetching ? 'Scanning…' : 'Scan for orphan files'}
        </button>
        {orphanFetching && (
          <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <Loader2 size={14} className="animate-spin" />
            <span>Walking storage directory — this may take a moment…</span>
          </div>
        )}
        {orphanResult && !orphanFetching && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Scanned {orphanResult.scanned_blobs} blobs in {orphanResult.duration_ms} ms
          </p>
        )}
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
          rows={orphanResult.orphan_files.map(f => ({
            id: f.id,
            col1: f.path,
            col1Title: f.path,
            col2: '—',
            col2Title: '',
            col3: formatBytes(f.size_bytes),
            col4: formatRelative(f.mod_time),
          }))}
          headers={['Path', 'Owner', 'Size', 'Modified']}
        />
      )}
      {orphanResult && !orphanFetching && orphanResult.orphan_files.length === 0 && (
        <p className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <span>✓</span> No orphan files found.
        </p>
      )}
    </div>
  )
}

// ── Shared table component ────────────────────────────────────────────────────

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
  icon, title, selected, onToggleAll, onToggle, onDelete, isDeleting, rows, headers,
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
}) {
  return (
    <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-[#2d3148]">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-sm font-semibold text-zinc-900 dark:text-slate-100">{title}</span>
        </div>
        {selected.size > 0 && (
          <button
            onClick={onDelete}
            disabled={isDeleting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-medium transition-colors"
          >
            <Trash2 size={13} />
            {isDeleting ? 'Deleting…' : `Delete ${selected.size} selected`}
          </button>
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
                {row.col1}
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
  updated_at: string
}

interface ScanResult {
  scanned_files: number
  corrupt_files: CorruptFile[]
  duration_ms: number
}

const SCAN_KEY = ['admin', 'storage-scan']

function StoragePage() {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [hasScanned, setHasScanned] = useState(false)

  // Use useQuery with enabled:false so the result is cached across navigation
  const { data: scanResult, isFetching, refetch } = useQuery<ScanResult>({
    queryKey: SCAN_KEY,
    queryFn: () => api.post<ScanResult>('/api/v1/admin/storage/scan'),
    enabled: false,
    staleTime: Infinity, // keep result until user explicitly rescans
  })

  const startScan = async () => {
    setHasScanned(true)
    setSelected(new Set())
    const result = await refetch()
    if (result.data) {
      if (result.data.corrupt_files.length === 0) {
        toast.success(`Scan complete — no corrupt files found (${result.data.scanned_files} scanned)`)
      } else {
        toast.warning(`Found ${result.data.corrupt_files.length} corrupt file(s) out of ${result.data.scanned_files} scanned`)
      }
    } else if (result.error) {
      toast.error('Scan failed')
    }
  }

  const purge = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ deleted: number; disk_deleted: number }>('/api/v1/admin/storage/purge-corrupt', { ids }),
    onSuccess: (data, ids) => {
      toast.success(`${data.deleted} record(s) removed — ${data.disk_deleted} file(s) deleted from disk`)
      queryClient.setQueryData<ScanResult>(SCAN_KEY, prev =>
        prev
          ? { ...prev, corrupt_files: prev.corrupt_files.filter(f => !ids.includes(f.id)) }
          : prev
      )
      setSelected(new Set())
    },
    onError: () => toast.error('Purge failed'),
  })

  const toggleAll = () => {
    if (!scanResult) return
    if (selected.size === scanResult.corrupt_files.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(scanResult.corrupt_files.map(f => f.id)))
    }
  }

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">Storage</h1>

      {/* Scan card */}
      <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">Corrupt file scan</h2>
        <p className="text-sm text-muted">
          Scans image files on disk and detects entries where the file content is an HTML/text
          error page instead of a valid image — a common result of failed WebDAV migrations from
          Nextcloud or similar systems.
        </p>
        <button
          onClick={startScan}
          disabled={isFetching}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {isFetching
            ? <Loader2 size={15} className="animate-spin" />
            : <ScanSearch size={15} />}
          {isFetching ? 'Scanning…' : 'Scan for corrupt files'}
        </button>

        {/* Loading indicator */}
        {isFetching && (
          <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <Loader2 size={14} className="animate-spin" />
            <span>Reading file magic bytes — this may take a moment…</span>
          </div>
        )}

        {scanResult && !isFetching && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Scanned {scanResult.scanned_files} files in {scanResult.duration_ms} ms
          </p>
        )}
      </section>

      {/* Results */}
      {scanResult && !isFetching && scanResult.corrupt_files.length > 0 && (
        <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-[#2d3148]">
            <div className="flex items-center gap-2">
              <AlertTriangle size={15} className="text-amber-500" />
              <span className="text-sm font-semibold text-zinc-900 dark:text-slate-100">
                {scanResult.corrupt_files.length} corrupt file(s) found
              </span>
            </div>
            {selected.size > 0 && (
              <button
                onClick={() => purge.mutate(Array.from(selected))}
                disabled={purge.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-xs font-medium transition-colors"
              >
                <Trash2 size={13} />
                {purge.isPending ? 'Deleting…' : `Delete ${selected.size} selected`}
              </button>
            )}
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-zinc-400 dark:text-zinc-500 border-b border-zinc-100 dark:border-[#2d3148]">
                <th className="px-4 py-2 text-left w-8">
                  <input
                    type="checkbox"
                    checked={selected.size === scanResult.corrupt_files.length}
                    onChange={toggleAll}
                    className="rounded"
                  />
                </th>
                <th className="px-4 py-2 text-left">Name</th>
                <th className="px-4 py-2 text-left">Owner</th>
                <th className="px-4 py-2 text-left">Size</th>
                <th className="px-4 py-2 text-left">Modified</th>
              </tr>
            </thead>
            <tbody>
              {scanResult.corrupt_files.map(f => (
                <tr
                  key={f.id}
                  className="border-b border-zinc-50 dark:border-[#1e2130] hover:bg-zinc-50 dark:hover:bg-[#1e2130]"
                >
                  <td className="px-4 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(f.id)}
                      onChange={() => toggle(f.id)}
                      className="rounded"
                    />
                  </td>
                  <td className="px-4 py-2 font-medium text-zinc-800 dark:text-slate-200 truncate max-w-xs" title={f.name}>
                    {f.name}
                  </td>
                  <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400 truncate max-w-[160px]" title={f.owner_name}>
                    {f.owner_name || f.owner_id.slice(0, 8)}
                  </td>
                  <td className="px-4 py-2 text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                    {formatBytes(f.size_bytes)}
                  </td>
                  <td className="px-4 py-2 text-zinc-400 dark:text-zinc-500 whitespace-nowrap">
                    {formatRelative(f.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {scanResult && !isFetching && scanResult.corrupt_files.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
          <span>✓</span>
          <span>No corrupt files found.</span>
        </div>
      )}
    </div>
  )
}
