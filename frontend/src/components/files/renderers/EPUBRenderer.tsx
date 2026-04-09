import { useEffect, useRef, useState } from 'react'
import ePub from 'epubjs'
import type Book from 'epubjs/types/book'
import type Rendition from 'epubjs/types/rendition'
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'

interface EPUBRendererProps {
  url: string
}

export function EPUBRenderer({ url }: EPUBRendererProps) {
  const viewerRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<Book | null>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [canPrev, setCanPrev] = useState(false)
  const [canNext, setCanNext] = useState(true)

  useEffect(() => {
    if (!viewerRef.current) return
    setLoading(true)
    setError(false)

    const book = ePub(url)
    bookRef.current = book

    const rendition = book.renderTo(viewerRef.current, {
      width: '100%',
      height: '100%',
      allowScriptedContent: false,
    })
    renditionRef.current = rendition

    rendition.display().then(() => {
      setLoading(false)
    }).catch(() => {
      setLoading(false)
      setError(true)
    })

    rendition.on('relocated', (location: { atStart: boolean; atEnd: boolean }) => {
      setCanPrev(!location.atStart)
      setCanNext(!location.atEnd)
    })

    book.ready.catch(() => {
      setLoading(false)
      setError(true)
    })

    return () => {
      rendition.destroy()
      book.destroy()
      bookRef.current = null
      renditionRef.current = null
    }
  }, [url])

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') renditionRef.current?.next()
      if (e.key === 'ArrowLeft') renditionRef.current?.prev()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="flex flex-col h-full">
      {/* Navigation bar */}
      <div className="flex items-center justify-center gap-4 px-4 py-2 border-b border-zinc-200 dark:border-[#2d3148] shrink-0 bg-zinc-50 dark:bg-[#1a1d27]">
        <button
          onClick={() => renditionRef.current?.prev()}
          disabled={!canPrev || loading}
          className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-40"
          title="Previous page"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="text-xs text-zinc-500 dark:text-slate-400">
          {loading ? 'Loading…' : 'Use arrow keys or buttons to navigate'}
        </span>
        <button
          onClick={() => renditionRef.current?.next()}
          disabled={!canNext || loading}
          className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-40"
          title="Next page"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Viewer area */}
      <div className="flex-1 relative bg-white dark:bg-[#f8f8f2] overflow-hidden">
        {loading && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-50 dark:bg-[#0f1117] z-10">
            <Loader2 size={28} className="animate-spin text-brand-500" />
            <span className="text-sm text-zinc-500 dark:text-slate-400">Loading book…</span>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-50 dark:bg-[#0f1117] z-10">
            <AlertTriangle size={36} className="text-zinc-300 dark:text-slate-600" />
            <span className="text-sm text-zinc-500 dark:text-slate-400">Failed to load EPUB.</span>
          </div>
        )}
        <div ref={viewerRef} className="w-full h-full" />
      </div>
    </div>
  )
}
