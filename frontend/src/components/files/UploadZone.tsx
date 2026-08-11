import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDropzone } from 'react-dropzone'
import { Upload, X } from 'lucide-react'
import * as tus from 'tus-js-client'
import { api } from '@/lib/api'
import type { FileItem } from '@/types/api'
import { ignorePromise } from '@/lib/ignore-promise'
import { createClientId } from '@/lib/client-id'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'

interface DropZoneProps {
  folderId: string | null
  onUploadStart: (files: File[]) => void
  children: React.ReactNode
}

export function DropZone({ folderId: _folderId, onUploadStart, children }: Readonly<DropZoneProps>) {
  const [dragActive, setDragActive] = useState(false)
  const { t } = useI18n()

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    noClick: true,
    onDrop: (accepted) => {
      setDragActive(false)
      if (accepted.length > 0) onUploadStart(accepted)
    },
    onDragEnter: () => setDragActive(true),
    onDragLeave: () => setDragActive(false),
  })

  return (
    <div
      {...getRootProps()}
      className={cn(
        'relative flex-1 flex flex-col transition-colors',
        (isDragActive || dragActive) && 'bg-brand-50/40 dark:bg-brand-900/10 outline outline-2 outline-dashed outline-brand-400 rounded-xl',
      )}
    >
      <input {...getInputProps()} />
      {(isDragActive || dragActive) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10 gap-2">
          <Upload size={28} className="text-brand-500" />
          <p className="text-sm font-medium text-brand-600 dark:text-brand-400">{t('upload.dragging')}</p>
        </div>
      )}
      {children}
    </div>
  )
}

// --- Upload progress queue ---

export interface UploadEntry {
  id: string
  file: File
  overwrite?: boolean
  progress: number
  status: 'queued' | 'uploading' | 'done' | 'error' | 'paused'
  error?: string
  speed?: number   // bytes/s
  eta?: number     // seconds remaining
  bytesUploaded?: number
}

interface UploadProgressProps {
  uploads: UploadEntry[]
  onDismiss: (id: string) => void
  directUpload?: boolean
}

function formatSpeed(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`
  if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${bps.toFixed(0)} B/s`
}

function formatEta(secs: number): string {
  if (secs < 60) return `${Math.ceil(secs)}s`
  const m = Math.floor(secs / 60)
  const s = Math.ceil(secs % 60)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

export function UploadProgress({ uploads, onDismiss, directUpload }: Readonly<UploadProgressProps>) {
  const active = uploads.filter(u => u.status !== 'done')
  const { t } = useI18n()

  if (active.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 w-80 bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl shadow-xl z-50 overflow-hidden">
      <div className="px-3 py-2 border-b border-zinc-100 dark:border-[#2d3148] flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-700 dark:text-slate-300">
          {t('upload.uploading', { count: String(active.length) })}
        </span>
        {directUpload && (
          <span className="text-[10px] font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-1.5 py-0.5 rounded">
            ⚡ {t('upload.direct')}
          </span>
        )}
      </div>
      <ul className="max-h-56 overflow-y-auto divide-y divide-zinc-100 dark:divide-[#2d3148]">
        {active.map(u => (
          <li key={u.id} className="px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="flex-1 text-xs text-zinc-900 dark:text-slate-100 truncate" title={u.file.name}>
                {u.file.name}
              </span>
              {u.status === 'error' && (
                <button onClick={() => onDismiss(u.id)}>
                  <X size={12} className="text-zinc-400" />
                </button>
              )}
            </div>
            {renderUploadStatus(u, t)}
          </li>
        ))}
      </ul>
      <div className="px-3 py-2 border-t border-zinc-100 dark:border-[#2d3148]">
        {directUpload ? (
          <p className="text-[10px] text-green-600 dark:text-green-400 leading-snug">
            {t('upload.directNote')}
          </p>
        ) : (
          <p className="text-[10px] text-zinc-400 dark:text-slate-500 leading-snug">
            {t('upload.cloudflareNote')}
          </p>
        )}
      </div>
    </div>
  )
}

function renderUploadStatus(u: UploadEntry, t: ReturnType<typeof useI18n>['t']) {
  if (u.status === 'error') {
    return (
      <p className="text-xs text-red-500">{u.error ?? t('upload.failed')}</p>
    )
  }

  if (u.status === 'paused') {
    return (
      <>
        <div className="h-1 rounded-full bg-zinc-100 dark:bg-[#2d3148] overflow-hidden mb-1">
          <div
            className="h-full bg-amber-500 transition-all duration-200"
            style={{ width: `${u.progress}%` }}
          />
        </div>
        <p className="text-[10px] text-amber-500 dark:text-amber-400">
          {t('upload.paused')}
        </p>
      </>
    )
  }

  return (
    <>
      <div className="h-1 rounded-full bg-zinc-100 dark:bg-[#2d3148] overflow-hidden mb-1">
        <div
          className="h-full bg-brand-500 transition-all duration-200"
          style={{ width: `${u.progress}%` }}
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-zinc-400 dark:text-slate-500">
          {u.bytesUploaded != null ? formatBytes(u.bytesUploaded) : '0 B'}
          {' / '}
          {formatBytes(u.file.size)}
        </span>
        <span className="text-[10px] text-zinc-400 dark:text-slate-500">
          {u.speed != null && u.speed > 0 ? formatSpeed(u.speed) : ''}
          {u.speed != null && u.speed > 0 && u.eta != null && u.eta > 0 ? ' · ' : ''}
          {u.eta != null && u.eta > 0 && u.speed != null && u.speed > 0 ? formatEta(u.eta) : ''}
        </span>
      </div>
      {/* Show a note while chunk boundary is being committed (speed drops to 0) */}
      {u.speed === 0 && u.progress > 0 && u.progress < 100 && (
        <p className="text-[10px] text-amber-500 dark:text-amber-400 mt-0.5">
          {t('upload.saving')}
        </p>
      )}
    </>
  )
}

// --- Upload hook ---

// Chunk size: 50 MB — safely below Cloudflare's 100 MB per-request limit.
const TUS_CHUNK_SIZE = 50 * 1024 * 1024

// Rolling window for speed calculation: keep last N samples over ~10 s
const SPEED_WINDOW = 10

function trimTrailingSlashes(input: string): string {
  let out = input
  while (out.endsWith('/')) out = out.slice(0, -1)
  return out
}

interface SpeedSample { time: number; bytes: number }

export interface UploadRequest {
  file: File
  overwrite?: boolean
  targetFolderId?: string | null
}

export interface PreparedFolderUpload {
  file: File
  targetFolderId: string | null
}

async function getFolderChildren(
  parentId: string | null,
  childrenByParent: Map<string, FileItem[]>,
): Promise<FileItem[]> {
  const parentKey = parentId ?? ''
  const cachedChildren = childrenByParent.get(parentKey)
  if (cachedChildren) return cachedChildren

  const query = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : ''
  const children = await api.get<FileItem[]>(`/api/v1/files${query}`)
  childrenByParent.set(parentKey, children)
  return children
}

async function findOrCreateChildFolder(
  folderName: string,
  parentId: string | null,
  childrenByParent: Map<string, FileItem[]>,
): Promise<string | undefined> {
  const children = await getFolderChildren(parentId, childrenByParent)
  const existing = children.find(item => item.name === folderName)
  if (existing) return existing.is_folder ? existing.id : undefined

  const folder = await api.post<FileItem>('/api/v1/files', {
    name: folderName,
    parent_id: parentId,
  })
  children.push(folder)
  return folder.id
}

async function resolveFolderPath(
  folderParts: string[],
  rootFolderId: string | null,
  folderIdsByPath: Map<string, string>,
  childrenByParent: Map<string, FileItem[]>,
): Promise<string | null | undefined> {
  let parentPath = ''
  let parentId = rootFolderId

  for (const folderName of folderParts) {
    const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName
    const cachedFolderId = folderIdsByPath.get(folderPath)
    if (cachedFolderId) {
      parentPath = folderPath
      parentId = cachedFolderId
      continue
    }

    const folderId = await findOrCreateChildFolder(folderName, parentId, childrenByParent)
    if (!folderId) return undefined

    folderIdsByPath.set(folderPath, folderId)
    parentPath = folderPath
    parentId = folderId
  }

  return parentId
}

export function useUploader(folderId: string | null, queryKey?: unknown[]) {
  const qc = useQueryClient()
  const [uploads, setUploads] = useState<UploadEntry[]>([])
  const uploadsRef = useRef<UploadEntry[]>([])
  // Per-upload rolling samples for speed calculation
  const speedSamples = useRef<Map<string, SpeedSample[]>>(new Map())
  // Track active tus Upload instances for pause/resume
  const tusUploads = useRef<Map<string, tus.Upload>>(new Map())

  // Pause/resume uploads when connectivity changes
  useEffect(() => {
    const handleOffline = () => {
      // Pause all active uploads
      for (const [id, upload] of tusUploads.current) {
        const entry = uploadsRef.current.find(u => u.id === id)
        if (entry?.status === 'uploading') {
          upload.abort()
          update(id, { status: 'paused', speed: undefined, eta: undefined })
        }
      }
    }
    const handleOnline = () => {
      // Resume all paused uploads
      for (const [id, upload] of tusUploads.current) {
        const entry = uploadsRef.current.find(u => u.id === id)
        if (entry?.status === 'paused') {
          update(id, { status: 'uploading' })
          upload.start()
        }
      }
    }
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    return () => {
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
  }, [])

  const syncRefs = useCallback((next: UploadEntry[]) => {
    uploadsRef.current = next
    return next
  }, [])

  const update = useCallback((id: string, patch: Partial<UploadEntry>) => {
    setUploads(prev => syncRefs(prev.map(u => u.id === id ? { ...u, ...patch } : u)))
  }, [syncRefs])

  const removeUpload = useCallback((id: string) => {
    tusUploads.current.delete(id)
    speedSamples.current.delete(id)
    setUploads(prev => syncRefs(prev.filter(u => u.id !== id)))
  }, [syncRefs])

  const refreshFolder = useCallback(() => {
    if (queryKey?.length) {
      ignorePromise(qc.invalidateQueries({ queryKey }))
      return
    }
    // Match the FilesPage query key exactly; root is keyed by `null`.
    const fallbackKey = ['files', folderId]
    ignorePromise(qc.invalidateQueries({ queryKey: fallbackKey }))
  }, [folderId, qc, queryKey])

  const { data: systemSettings } = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: ({ signal }) => api.get<{ direct_uploads_enabled?: boolean; upload_endpoint?: string }>('/api/v1/system/settings', signal),
    staleTime: 60_000,
  })

  const directUpload = !!systemSettings?.direct_uploads_enabled

  const createTusUpload = useCallback(async (
    request: UploadRequest,
    targetFolderId: string | null,
    entryId: string,
  ) => {
    const endpointBase = trimTrailingSlashes(systemSettings?.upload_endpoint ?? '')
    const endpoint = endpointBase || '/api/v1/files/upload/resumable'
    const metadata: Record<string, string> = {
      filename: request.file.name,
    }
    // The TUS server contract uses `folder_id` (the multipart endpoint uses
    // `parent_id`). Sending `parent_id` here silently finalized uploads at root.
    if (targetFolderId) metadata.folder_id = targetFolderId
    if (request.overwrite) metadata.overwrite = '1'

    return new tus.Upload(request.file, {
      endpoint,
      chunkSize: TUS_CHUNK_SIZE,
      metadata,
      retryDelays: [0, 1000, 3000, 5000],
      removeFingerprintOnSuccess: true,
      onError: (err) => {
        update(entryId, { status: 'error', error: err.message, speed: undefined, eta: undefined })
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        const percent = bytesTotal > 0 ? Math.round((bytesUploaded / bytesTotal) * 100) : 0
        const now = Date.now()
        const samples = speedSamples.current.get(entryId) ?? []
        samples.push({ time: now, bytes: bytesUploaded })
        while (samples.length > SPEED_WINDOW) samples.shift()
        speedSamples.current.set(entryId, samples)

        let speed: number | undefined
        let eta: number | undefined
        if (samples.length >= 2) {
          const first = samples[0]
          const last = samples[samples.length - 1]
          const dt = (last.time - first.time) / 1000
          const db = last.bytes - first.bytes
          if (dt > 0 && db >= 0) {
            speed = db / dt
            if (speed > 0) eta = (bytesTotal - bytesUploaded) / speed
          }
        }

        update(entryId, { progress: percent, bytesUploaded, speed, eta, status: 'uploading' })
      },
      onSuccess: () => {
        update(entryId, { progress: 100, status: 'done', speed: undefined, eta: undefined })
        refreshFolder()
      },
    })
  }, [refreshFolder, systemSettings?.upload_endpoint, update])

  const startUpload = useCallback(async (requests: UploadRequest[], overrideFolderId?: string | null) => {
    // `null` explicitly means the root folder. Only fall back to the currently
    // open folder when no override was supplied at all.
    const targetFolderId = overrideFolderId === undefined ? folderId : overrideFolderId
    const newEntries = requests.map(request => ({
      id: createClientId(),
      file: request.file,
      overwrite: request.overwrite,
      progress: 0,
      status: 'queued' as const,
      bytesUploaded: 0,
    }))

    setUploads(prev => syncRefs([...prev, ...newEntries]))

    for (let i = 0; i < newEntries.length; i += 1) {
      const entry = newEntries[i]
      const request = requests[i]
      const requestTargetFolderId = request.targetFolderId === undefined
        ? targetFolderId
        : request.targetFolderId

      if (directUpload) {
        const upload = await createTusUpload(request, requestTargetFolderId, entry.id)
        tusUploads.current.set(entry.id, upload)
        update(entry.id, { status: 'uploading' })
        upload.start()
        continue
      }

      try {
        const formData = new FormData()
        formData.append('file', request.file)
        if (requestTargetFolderId) formData.append('folder_id', requestTargetFolderId)
        if (request.overwrite) formData.append('overwrite', '1')
        update(entry.id, { status: 'uploading' })
        await api.post<FileItem>('/api/v1/files/upload', formData)
        update(entry.id, { progress: 100, status: 'done' })
        refreshFolder()
      } catch (err) {
        update(entry.id, {
          status: 'error',
          error: err instanceof Error ? err.message : 'Upload failed',
        })
      }
    }
  }, [createTusUpload, directUpload, folderId, refreshFolder, syncRefs, update])

  const dismiss = useCallback((id: string) => {
    removeUpload(id)
  }, [removeUpload])

  const prepareFolderUpload = useCallback(async (files: FileList | File[]): Promise<PreparedFolderUpload[]> => {
    const prepared: PreparedFolderUpload[] = []
    const folderIdsByPath = new Map<string, string>()
    const childrenByParent = new Map<string, FileItem[]>()

    for (const file of Array.from(files)) {
      const pathParts = (file.webkitRelativePath || file.name).split('/').filter(Boolean)
      const folderParts = pathParts.slice(0, -1)
      const targetFolderId = await resolveFolderPath(folderParts, folderId, folderIdsByPath, childrenByParent)
      if (targetFolderId !== undefined) prepared.push({ file, targetFolderId })
    }

    return prepared
  }, [folderId])

  return {
    uploads,
    directUpload,
    startUpload,
    dismiss,
    prepareFolderUpload,
  }
}
