import { useCallback, useEffect, useMemo, useState } from 'react'
import { X, Download, AlertTriangle, Loader2, Printer, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'
import type { FileItem } from '@/types/api'
import { PDFRenderer } from './renderers/PDFRenderer'
import { STLRenderer } from './renderers/STLRenderer'
import { ThreeMFRenderer } from './renderers/ThreeMFRenderer'
import { AudioRenderer } from './renderers/AudioRenderer'
import { PlaylistPlayer } from './renderers/PlaylistPlayer'
import { EPUBRenderer } from './renderers/EPUBRenderer'

interface PreviewModalProps {
  item: FileItem
  /** All files in the current folder — used for prev/next navigation */
  siblings?: FileItem[]
  onClose: () => void
  /** Called when the user wants to permanently delete a broken file */
  onDelete?: (item: FileItem) => void
}

type PreviewKind = 'pdf' | 'image' | 'text' | 'video' | 'audio' | 'stl' | '3mf' | 'office' | 'epub' | 'playlist' | 'unsupported'

const TEXT_EXTS = new Set([
  'txt', 'md', 'json', 'yaml', 'yml', 'toml', 'ini', 'xml', 'csv', 'log',
  'sh', 'bash', 'py', 'js', 'ts', 'jsx', 'tsx', 'go', 'rs', 'rb', 'php',
  'html', 'css', 'sql', 'env', 'gitignore',
])
const OFFICE_EXTS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'])
// Google Drive stub files — contain a URL/JSON pointer, not real office content
const GOOGLE_STUB_EXTS = new Set(['gsheet', 'gdoc', 'gslides', 'gdraw', 'gform', 'gmap', 'gsite'])

function fileExt(name: string) {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

function detectKind(item: FileItem): PreviewKind {
  const mime = item.mime_type ?? ''
  const e = fileExt(item.name)
  if (GOOGLE_STUB_EXTS.has(e)) return 'unsupported'
  if (e === 'pdf' || mime === 'application/pdf') return 'pdf'
  if (e === 'm3u' || mime === 'audio/mpegurl') return 'playlist'
  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(e)) return 'image'
  if (mime.startsWith('video/') || ['mp4', 'webm', 'ogg', 'mov', 'm4v'].includes(e)) return 'video'
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'flac', 'aac', 'm4a', 'opus'].includes(e)) return 'audio'
  if (e === 'stl') return 'stl'
  if (e === '3mf') return '3mf'
  if (e === 'epub') return 'epub'
  if (OFFICE_EXTS.has(e)) return 'office'
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || TEXT_EXTS.has(e)) return 'text'
  return 'unsupported'
}

export function PreviewModal({ item, siblings, onClose, onDelete }: PreviewModalProps) {
  // Internal navigation state — currentItem changes as user goes prev/next
  const [currentItem, setCurrentItem] = useState(item)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Sync when the parent swaps out the item prop entirely (e.g. parent-level navigation)
  useEffect(() => { setCurrentItem(item); setConfirmDelete(false) }, [item.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const kind = detectKind(currentItem)
  const previewUrl = `/api/v1/files/${currentItem.id}/preview`
  const pdfUrl = `/api/v1/files/${currentItem.id}/preview/pdf`

  // All non-folder siblings available for prev/next navigation
  const navItems = useMemo(() => (siblings ?? []).filter(f => !f.is_folder), [siblings])
  const navIdx = navItems.findIndex(f => f.id === currentItem.id)
  const canNav = navItems.length > 1

  const goPrev = useCallback(() => {
    if (!canNav) return
    setConfirmDelete(false)
    setCurrentItem(navItems[(navIdx - 1 + navItems.length) % navItems.length])
  }, [canNav, navIdx, navItems])

  const goNext = useCallback(() => {
    if (!canNav) return
    setConfirmDelete(false)
    setCurrentItem(navItems[(navIdx + 1) % navItems.length])
  }, [canNav, navIdx, navItems])

  const isPrintable = kind === 'pdf' || kind === 'office' || kind === 'image' || kind === 'text'
  const isPlaylist = kind === 'playlist'

  const handlePrint = useCallback(() => {
    const url = kind === 'office' ? pdfUrl : previewUrl
    const iframe = document.createElement('iframe')
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:0'

    if (kind === 'image') {
      // Inject a minimal HTML document so the image fills the print page
      document.body.appendChild(iframe)
      const doc = iframe.contentDocument!
      doc.open()
      doc.write(
        `<!DOCTYPE html><html><head><style>` +
        `body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh}` +
        `img{max-width:100%;max-height:100vh;object-fit:contain}` +
        `</style></head><body><img src="${url}"></body></html>`
      )
      doc.close()
      setTimeout(() => {
        iframe.contentWindow?.print()
        iframe.contentWindow!.onafterprint = () => iframe.remove()
      }, 400)
    } else {
      iframe.src = url
      document.body.appendChild(iframe)
      iframe.onload = () => {
        iframe.contentWindow?.print()
        iframe.contentWindow!.onafterprint = () => iframe.remove()
      }
    }
  }, [kind, previewUrl, pdfUrl])

  // Keyboard: Escape closes, ← / → navigate
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') goPrev()
      if (e.key === 'ArrowRight') goNext()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, goPrev, goNext])

  const handleBackdrop = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={handleBackdrop}
    >
      <div className="relative flex flex-col bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl shadow-2xl w-[90vw] max-w-5xl h-[85vh]">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-200 dark:border-[#2d3148] shrink-0">
          {/* Prev / Next — fixed-width group so the filename never shifts */}
          <div className="flex items-center shrink-0">
            <button
              onClick={goPrev}
              disabled={!canNav}
              className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors text-zinc-500 dark:text-slate-400 disabled:opacity-20 disabled:cursor-default"
              title="Previous (←)"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={goNext}
              disabled={!canNav}
              className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors text-zinc-500 dark:text-slate-400 disabled:opacity-20 disabled:cursor-default"
              title="Next (→)"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <span className="flex-1 text-sm font-medium text-zinc-900 dark:text-slate-100 truncate min-w-0" title={currentItem.name}>{currentItem.name}</span>

          <a
            href={`/api/v1/files/${currentItem.id}/download`}
            download={currentItem.name}
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
          >
            <Download size={12} />
            Download
          </a>
          {isPrintable && (
            <button
              onClick={handlePrint}
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
              title="Print"
            >
              <Printer size={12} />
              Print
            </button>
          )}
          {onDelete && (
            confirmDelete ? (
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-xs text-zinc-500 dark:text-slate-400 hidden sm:inline">Delete file?</span>
                <button
                  onClick={() => { setConfirmDelete(false); onDelete(currentItem) }}
                  className="px-2.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium transition-colors"
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-600 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="shrink-0 p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors text-zinc-400 hover:text-red-600 dark:hover:text-red-400"
                title="Delete file"
              >
                <Trash2 size={15} />
              </button>
            )
          )}
          <button
            onClick={onClose}
            className="shrink-0 p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors text-zinc-500 dark:text-slate-400"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {kind === 'pdf' && <PDFRenderer url={previewUrl} loadingText="Loading PDF…" />}
          {kind === 'office' && <PDFRenderer url={pdfUrl} loadingText="Preparing preview…" />}
          {kind === 'epub' && <EPUBRenderer url={previewUrl} />}
          {kind === 'image' && (
            <ImageRenderer
              key={previewUrl}
              url={previewUrl}
              name={currentItem.name}
              onDelete={onDelete ? () => onDelete(currentItem) : undefined}
            />
          )}
          {kind === 'video' && (
            <div className="flex items-center justify-center h-full bg-black p-2">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video src={previewUrl} controls className="max-w-full max-h-full" />
            </div>
          )}
          {kind === 'audio' && (
            <AudioRenderer
              url={previewUrl}
              fileName={currentItem.name}
              fileId={currentItem.id}
              mimeType={currentItem.mime_type ?? ''}
            />
          )}
          {kind === 'text' && <TextRenderer url={previewUrl} />}
          {kind === 'stl' && <STLRenderer url={previewUrl} />}
          {kind === '3mf' && <ThreeMFRenderer url={previewUrl} />}
          {isPlaylist && <PlaylistPlayer fileId={item.id} />}
          {kind === 'unsupported' && (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-muted">
              <AlertTriangle size={48} className="text-zinc-300 dark:text-slate-600" />
              <p className="text-sm">
                {GOOGLE_STUB_EXTS.has(fileExt(currentItem.name))
                  ? 'This is a Google Drive file and can only be opened in Google Drive.'
                  : 'This file type cannot be previewed.'}
              </p>
              <a
                href={`/api/v1/files/${currentItem.id}/download`}
                download={currentItem.name}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium"
              >
                <Download size={14} />
                Download instead
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ImageRenderer({ url, name, onDelete }: { url: string; name: string; onDelete?: () => void }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  // Fetch as raw bytes and create a blob: URL so the browser sniffs the image
  // format from the actual file content — bypasses any wrong Content-Type header
  // and X-Content-Type-Options: nosniff restrictions entirely.
  useEffect(() => {
    const controller = new AbortController()
    setObjectUrl(null)
    setLoaded(false)
    setError(false)
    fetch(url, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.arrayBuffer()
      })
      .then(buf => {
        // No explicit type — browser infers format from the raw bytes.
        const blob = new Blob([buf])
        setObjectUrl(URL.createObjectURL(blob))
      })
      .catch(err => {
        if (err.name !== 'AbortError') setError(true)
      })
    return () => { controller.abort() }
  }, [url])

  // Revoke the object URL when it's replaced or the component unmounts.
  useEffect(() => {
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [objectUrl])

  return (
    <div className="flex items-center justify-center h-full bg-zinc-50 dark:bg-[#0f1117] p-4 overflow-auto relative">
      {!loaded && !error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 size={28} className="animate-spin text-brand-500" />
        </div>
      )}
      {error ? (
        <div className="flex flex-col items-center gap-3 text-muted">
          <AlertTriangle size={40} className="text-amber-400 dark:text-amber-500" />
          <span className="text-sm font-medium">Failed to load image.</span>
          <span className="text-xs text-zinc-400 dark:text-zinc-500">The file may be corrupted.</span>
          {onDelete && (
            <button
              onClick={onDelete}
              className="mt-2 flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors"
            >
              <Trash2 size={14} />
              Delete corrupted file
            </button>
          )}
        </div>
      ) : objectUrl ? (
        <img
          src={objectUrl}
          alt={name}
          className={`max-w-full max-h-full object-contain transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
          onLoad={() => setLoaded(true)}
          onError={() => { setLoaded(true); setError(true) }}
        />
      ) : null}
    </div>
  )
}

function TextRenderer({ url }: { url: string }) {
  const [content, setContent] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    // AbortController ensures the in-flight fetch is cancelled when the
    // component unmounts or url changes, preventing stale state updates.
    const controller = new AbortController()
    fetch(url, { signal: controller.signal })
      .then(async res => {
        if (!res.ok) throw new Error('Failed to load')
        setTruncated(res.headers.get('X-Preview-Truncated') === 'true')
        return res.text()
      })
      .then(setContent)
      .catch(err => {
        if ((err as { name?: string })?.name !== 'AbortError') setError(true)
      })
    return () => controller.abort()
  }, [url])

  if (error) return <div className="flex items-center justify-center h-full text-sm text-muted">Failed to load file.</div>
  if (content === null) return <div className="flex items-center justify-center h-full text-sm text-muted">Loading…</div>

  return (
    <div className="flex flex-col h-full">
      {truncated && (
        <div className="px-4 py-2 bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 text-xs text-yellow-700 dark:text-yellow-400 shrink-0">
          Preview truncated to 1 MB. Download the file to see the complete contents.
        </div>
      )}
      <pre className="flex-1 p-4 overflow-auto text-xs font-mono whitespace-pre-wrap break-all text-zinc-800 dark:text-slate-200 bg-zinc-50 dark:bg-[#0f1117]">
        {content}
      </pre>
    </div>
  )
}
