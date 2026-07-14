import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, ZoomIn, ZoomOut } from 'lucide-react'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

interface PDFRendererProps {
  url: string
  /** Text shown beneath the spinner while the PDF is loading. Defaults to "Loading PDF…" */
  loadingText?: string
}

export function PDFRenderer({ url, loadingText = 'Loading PDF…' }: Readonly<PDFRendererProps>) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [scale, setScale] = useState(1.5)
  const [loadError, setLoadError] = useState(false)
  const renderTaskRef = useRef<RenderTask | null>(null)

  useEffect(() => {
    let cancelled = false
    let loadedDoc: PDFDocumentProxy | null = null
    setLoadError(false)
    // getDocument returns a PDFDocumentLoadingTask with its own .destroy()
    const loadingTask = pdfjsLib.getDocument(url)
    loadingTask.promise
      .then(doc => {
        if (cancelled) {
          // Component unmounted before load finished — destroy immediately to
          // free the internal ArrayBuffer and worker memory.
          doc.destroy()
          return
        }
        loadedDoc = doc
        setPdf(doc)
        setTotalPages(doc.numPages)
        setPage(1)
      })
      .catch(err => {
        if (!cancelled) {
          console.error(err)
          setLoadError(true)
        }
      })
    return () => {
      cancelled = true
      // Cancel an in-flight network load (if still pending).
      loadingTask.destroy()
      // Destroy the document if it already resolved — frees worker + heap memory.
      loadedDoc?.destroy()
      setPdf(null)
    }
  }, [url])

  useEffect(() => {
    if (!pdf || !canvasRef.current) return
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel()
      renderTaskRef.current = null
    }
    let cancelled = false
    pdf.getPage(page).then(pdfPage => {
      if (cancelled || !canvasRef.current) return
      const viewport = pdfPage.getViewport({ scale })
      const canvas = canvasRef.current
      canvas.height = viewport.height
      canvas.width = viewport.width
      const ctx = canvas.getContext('2d')!
      const task = pdfPage.render({ canvasContext: ctx, viewport, canvas })
      renderTaskRef.current = task
      return task.promise
    }).catch(err => {
      if ((err as { name?: string })?.name !== 'RenderingCancelledException') console.error(err)
    })
    return () => {
      cancelled = true
      // Cancel any outstanding render task on unmount (not only at the next run start).
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel()
        renderTaskRef.current = null
      }
    }
  }, [pdf, page, scale])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-center gap-3 px-4 py-2 border-b border-zinc-200 dark:border-[#2d3148] shrink-0 bg-zinc-50 dark:bg-[#1a1d27]">
        <button
          onClick={() => setScale(s => Math.max(0.5, s - 0.25))}
          className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-[#2d3148] transition-colors"
          title="Zoom out"
        >
          <ZoomOut size={16} />
        </button>
        <span className="text-xs text-muted w-12 text-center">{Math.round(scale * 100)}%</span>
        <button
          onClick={() => setScale(s => Math.min(4, s + 0.25))}
          className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-[#2d3148] transition-colors"
          title="Zoom in"
        >
          <ZoomIn size={16} />
        </button>
        <div className="w-px h-4 bg-zinc-300 dark:bg-[#2d3148]" />
        <button
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page === 1}
          className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-40"
          title="Previous page"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="text-xs text-muted">{page} / {totalPages}</span>
        <button
          onClick={() => setPage(p => Math.min(totalPages, p + 1))}
          disabled={page === totalPages || totalPages === 0}
          className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-40"
          title="Next page"
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-auto flex justify-center p-4 bg-zinc-100 dark:bg-[#0f1117] relative">
        {!pdf && !loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Loader2 size={28} className="animate-spin text-brand-500" />
            <span className="text-sm text-muted">{loadingText}</span>
          </div>
        )}
        {loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <AlertTriangle size={36} className="text-zinc-300 dark:text-slate-600" />
            <span className="text-sm text-muted">Preview generation failed.</span>
          </div>
        )}
        <canvas ref={canvasRef} className="shadow-lg" />
      </div>
    </div>
  )
}
