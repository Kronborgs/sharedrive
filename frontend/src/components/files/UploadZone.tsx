import { useState, useRef } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, X } from 'lucide-react'
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

import { useCallback, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as tus from 'tus-js-client'
import { api } from '@/lib/api'
import type { FileItem } from '@/types/api'
import { ignorePromise } from '@/lib/ignore-promise'

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
}

export interface PreparedFolderUpload {
  file: File
  targetFolderId: string | null
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

  // Fetch direct_upload_url from public system settings (no auth required)
  const { data: settings } = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: ({ signal }) => api.get<{ direct_upload_url?: string }>('/api/v1/system/settings', signal),
    staleTime: 5 * 60 * 1000, // 5 min
  })

  const update = (id: string, patch: Partial<UploadEntry>) => {
    setUploads(prev => {
      const next = prev.map(u => u.id === id ? { ...u, ...patch } : u)
      uploadsRef.current = next
      return next
    })
  }

  const startUpload = useCallback((files: Array<File | UploadRequest>, targetFolderId: string | null = folderId) => {
    // Determine TUS endpoint: prefer direct_upload_url (bypasses Cloudflare) if set
    const directUploadUrl = settings?.direct_upload_url?.trim() ?? undefined
    const directBase = directUploadUrl && trimTrailingSlashes(directUploadUrl)
    const tusEndpoint = directBase ? `${directBase}/upload/` : '/upload/'
    // No chunking when uploading directly (no Cloudflare 100 MB limit).
    // When going through Cloudflare, keep 50 MB chunks to stay under their limit.
    const chunkSize = directBase ? Infinity : TUS_CHUNK_SIZE
    // Allow caller to override the target folder (e.g. when coming from share target)
    const effectiveFolderId = targetFolderId

    const normalized: UploadRequest[] = files.map(item => {
      if (item instanceof File) return { file: item, overwrite: false }
      return { file: item.file, overwrite: !!item.overwrite }
    })

    const entries: UploadEntry[] = normalized.map(({ file, overwrite }) => ({
      id: crypto.randomUUID(),
      file,
      overwrite,
      progress: 0,
      status: 'queued' as const,
    }))

    setUploads(prev => {
      const next = [...prev, ...entries]
      uploadsRef.current = next
      return next
    })

    // When using the direct upload subdomain, fetch a short-lived upload token so
    // authentication works cross-subdomain (session cookie may not be forwarded).
    const startEntries = async () => {
      let uploadToken: string | undefined
      if (directBase) {
        try {
          const res = await api.post<{ token: string }>('/api/v1/upload-token', { folder_id: effectiveFolderId ?? '' })
          uploadToken = res.token
        } catch (err) {
          // Uploads will still work via cookie auth on the main domain.
          // Log a warning so auth failures are visible.
          console.warn('[UploadZone] Failed to fetch upload token; falling back to cookie auth:', err)
        }
      }

      for (const entry of entries) {
        update(entry.id, { status: 'uploading' })

        const extraHeaders: Record<string, string> = {}
        if (uploadToken) extraHeaders['X-Upload-Token'] = uploadToken

        const upload = new tus.Upload(entry.file, {
          endpoint: tusEndpoint,
          chunkSize: chunkSize,
          retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000],
          headers: extraHeaders,
          metadata: {
            filename: entry.file.name,
            filetype: entry.file.type || 'application/octet-stream',
            folder_id: effectiveFolderId ?? '',
            overwrite: entry.overwrite ? '1' : '0',
          },
          onError: (error) => {
            let msg = 'Upload failed'
            const det = error as tus.DetailedError
            if (det.originalResponse != null) {
              try {
                const body = det.originalResponse.getBody()
                const data = JSON.parse(body) as { error?: string | { message?: string } }
                if (data.error) {
                  msg = typeof data.error === 'string' ? data.error : (data.error.message ?? 'Upload failed')
                }
              } catch { /* ignore */ }
            }
            tusUploads.current.delete(entry.id)
            update(entry.id, { status: 'error', error: msg })
          },
          onProgress: (bytesUploaded, bytesTotal) => {
            const progress = bytesTotal > 0 ? Math.round((bytesUploaded / bytesTotal) * 100) : 0

            // Rolling-window speed calculation
            const now = Date.now()
            const samples = speedSamples.current.get(entry.id) ?? []
            samples.push({ time: now, bytes: bytesUploaded })
            // Keep only the last SPEED_WINDOW samples
            while (samples.length > SPEED_WINDOW) samples.shift()
            speedSamples.current.set(entry.id, samples)

            let speed: number | undefined
            let eta: number | undefined
            if (samples.length >= 2) {
              const oldest = samples[0]
              const newest = samples[samples.length - 1]
              const elapsed = (newest.time - oldest.time) / 1000
              if (elapsed > 0) {
                speed = (newest.bytes - oldest.bytes) / elapsed
                if (speed > 0 && bytesTotal > bytesUploaded) {
                  eta = (bytesTotal - bytesUploaded) / speed
                }
              }
            }

            update(entry.id, { progress, speed, eta, bytesUploaded })
          },
          onSuccess: () => {
            speedSamples.current.delete(entry.id)
            tusUploads.current.delete(entry.id)
            update(entry.id, { status: 'done', progress: 100 })
            ignorePromise(qc.invalidateQueries({ queryKey: queryKey ?? ['files', effectiveFolderId] }))
            ignorePromise(qc.invalidateQueries({ queryKey: ['me'] }))
            setTimeout(() => {
              setUploads(prev => {
                const next = prev.filter(u => u.id !== entry.id)
                uploadsRef.current = next
                return next
              })
            }, 2000)
          },
        })
        tusUploads.current.set(entry.id, upload)

        // If offline at start time, queue as paused instead of starting
        if (!navigator.onLine) {
          update(entry.id, { status: 'paused' })
        } else {
          upload.start()
        }
      }
    }

    ignorePromise(startEntries())
  }, [folderId, qc, settings])

  const dismiss = useCallback((id: string) => {
    const tusUpload = tusUploads.current.get(id)
    if (tusUpload) {
      tusUpload.abort()
      tusUploads.current.delete(id)
    }
    speedSamples.current.delete(id)
    setUploads(prev => {
      const next = prev.filter(u => u.id !== id)
      uploadsRef.current = next
      return next
    })
  }, [])

  // Folder upload: create the server folder tree and return each file with its target folder.
  // Reads webkitRelativePath from each File to reconstruct the hierarchy.
  const prepareFolderUpload = useCallback(async (fileList: FileList): Promise<PreparedFolderUpload[]> => {
    const files = Array.from(fileList) as (File & { webkitRelativePath: string })[]
    if (files.length === 0) return []

    // Map path string → server folder ID. Empty string = current root.
    const folderIdMap = new Map<string, string>()
    folderIdMap.set('', folderId ?? '')

    // Collect unique directory paths, sorted shallowest-first so parents are created before children.
    const folderPaths = new Set<string>()
    for (const file of files) {
      const parts = file.webkitRelativePath.split('/')
      for (let i = 1; i < parts.length; i++) {
        folderPaths.add(parts.slice(0, i).join('/'))
      }
    }
    const sortedPaths = Array.from(folderPaths).sort((a, b) => {
      const da = a.split('/').length
      const db = b.split('/').length
      return da !== db ? da - db : a.localeCompare(b)
    })

    // Create each folder on the server in order.
    for (const folderPath of sortedPaths) {
      const parts = folderPath.split('/')
      const name = parts.at(-1) ?? ''
      const parentPath = parts.slice(0, -1).join('/')
      const parentId = folderIdMap.get(parentPath) ?? folderId
      try {
        const created = await api.post<FileItem>('/api/v1/files', {
          name,
          parent_id: parentId || null,
        })
        folderIdMap.set(folderPath, created.id)
      } catch {
        // Ignore — folder may already exist. Files will still upload.
      }
    }

    // Queue each file upload into its correct folder.
    const prepared: PreparedFolderUpload[] = []
    for (const file of files) {
      const parts = file.webkitRelativePath.split('/')
      const dirPath = parts.slice(0, -1).join('/')
      const targetId = folderIdMap.get(dirPath) ?? folderId
      prepared.push({ file, targetFolderId: targetId })
    }

    return prepared
  }, [folderId])

  const startFolderUpload = useCallback(async (fileList: FileList) => {
    const prepared = await prepareFolderUpload(fileList)
    if (prepared.length === 0) return

    const grouped = new Map<string, File[]>()
    for (const entry of prepared) {
      const key = entry.targetFolderId ?? ''
      const list = grouped.get(key)
      if (list) list.push(entry.file)
      else grouped.set(key, [entry.file])
    }

    for (const [key, filesForFolder] of grouped) {
      startUpload(filesForFolder, key === '' ? folderId : key)
    }

    ignorePromise(qc.invalidateQueries({ queryKey: queryKey ?? ['files', folderId] }))
  }, [folderId, qc, startUpload, queryKey, prepareFolderUpload])

  return { uploads, startUpload, startFolderUpload, prepareFolderUpload, dismiss, directUpload: !!(settings?.direct_upload_url?.trim()) }
}
