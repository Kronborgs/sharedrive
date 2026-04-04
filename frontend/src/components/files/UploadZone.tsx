import { useState, useRef } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface DropZoneProps {
  folderId: string | null
  onUploadStart: (files: File[]) => void
  children: React.ReactNode
}

export function DropZone({ folderId: _folderId, onUploadStart, children }: DropZoneProps) {
  const [dragActive, setDragActive] = useState(false)

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
          <p className="text-sm font-medium text-brand-600 dark:text-brand-400">Drop files here to upload</p>
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
  progress: number
  status: 'queued' | 'uploading' | 'done' | 'error'
  error?: string
}

interface UploadProgressProps {
  uploads: UploadEntry[]
  onDismiss: (id: string) => void
}

export function UploadProgress({ uploads, onDismiss }: UploadProgressProps) {
  const active = uploads.filter(u => u.status !== 'done')

  if (active.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 w-80 bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl shadow-xl z-50 overflow-hidden">
      <div className="px-3 py-2 border-b border-zinc-100 dark:border-[#2d3148] flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-700 dark:text-slate-300">
          Uploading {active.length} file{active.length > 1 ? 's' : ''}
        </span>
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
            {u.status === 'error' ? (
              <p className="text-xs text-red-500">{u.error ?? 'Upload failed'}</p>
            ) : (
              <div className="h-1 rounded-full bg-zinc-100 dark:bg-[#2d3148] overflow-hidden">
                <div
                  className="h-full bg-brand-500 transition-all duration-200"
                  style={{ width: `${u.progress}%` }}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

// --- Upload hook ---

import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'

export function useUploader(folderId: string | null) {
  const qc = useQueryClient()
  const [uploads, setUploads] = useState<UploadEntry[]>([])
  const uploadsRef = useRef<UploadEntry[]>([])

  const update = (id: string, patch: Partial<UploadEntry>) => {
    setUploads(prev => {
      const next = prev.map(u => u.id === id ? { ...u, ...patch } : u)
      uploadsRef.current = next
      return next
    })
  }

  const startUpload = useCallback((files: File[]) => {
    const entries: UploadEntry[] = files.map(file => ({
      id: crypto.randomUUID(),
      file,
      progress: 0,
      status: 'queued' as const,
    }))

    setUploads(prev => {
      const next = [...prev, ...entries]
      uploadsRef.current = next
      return next
    })

    for (const entry of entries) {
      update(entry.id, { status: 'uploading' })

      const formData = new FormData()
      formData.append('file', entry.file)
      formData.append('folder_id', folderId ?? '')

      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/v1/files/upload')
      xhr.withCredentials = true

      xhr.upload.onprogress = (e: ProgressEvent) => {
        if (e.lengthComputable) {
          update(entry.id, { progress: Math.round((e.loaded / e.total) * 100) })
        }
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          update(entry.id, { status: 'done', progress: 100 })
          void qc.invalidateQueries({ queryKey: ['files', folderId] })
          setTimeout(() => {
            setUploads(prev => {
              const next = prev.filter(u => u.id !== entry.id)
              uploadsRef.current = next
              return next
            })
          }, 2000)
        } else {
          let msg = 'Upload failed'
          try {
            const data = JSON.parse(xhr.responseText) as { error?: string }
            if (data.error) msg = data.error
          } catch { /* ignore */ }
          update(entry.id, { status: 'error', error: msg })
        }
      }

      xhr.onerror = () => {
        update(entry.id, { status: 'error', error: 'Network error' })
      }

      xhr.send(formData)
    }
  }, [folderId, qc])

  const dismiss = useCallback((id: string) => {
    setUploads(prev => {
      const next = prev.filter(u => u.id !== id)
      uploadsRef.current = next
      return next
    })
  }, [])

  return { uploads, startUpload, dismiss }
}
