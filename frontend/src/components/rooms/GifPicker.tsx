import { useEffect, useRef, useState } from 'react'
import { Image, Search, X } from 'lucide-react'
import { FloatingPanel } from '@/components/rooms/FloatingPanel'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

interface GIFItem {
  id: string
  file_id: string
  title: string
  category?: string
  name: string
  mime_type: string
}

export function GifPicker({ onSelect }: Readonly<{ onSelect: (fileID: string, name: string, mimeType: string) => void }>) {
  const { t } = useI18n()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [items, setItems] = useState<GIFItem[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => { const timer = window.setTimeout(() => setDebouncedQuery(query), 250); return () => window.clearTimeout(timer) }, [query])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true); setFailed(false)
    api.get<{ items: GIFItem[] }>(`/api/v1/rooms/gifs?q=${encodeURIComponent(debouncedQuery)}&limit=24`, controller.signal)
      .then(result => setItems(result.items))
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [debouncedQuery, open])

  const choose = (item: GIFItem) => { onSelect(item.file_id, item.name, item.mime_type); setOpen(false); setQuery('') }
  return <span className="inline-flex">
    <button ref={buttonRef} type="button" onClick={() => setOpen(value => !value)} className="rounded-full px-2.5 py-2 text-xs font-bold text-muted hover:bg-zinc-100 dark:hover:bg-[#2d3148]" aria-label={t('rooms.chooseGif' as never)} title={t('rooms.chooseGif' as never)} aria-expanded={open}>GIF</button>
    <FloatingPanel anchorRef={buttonRef} open={open} onOpenChange={setOpen} ariaLabel={t('rooms.chooseGif' as never)} className="w-[min(24rem,calc(100vw-1rem))] p-3">
      <div className="mb-3 flex items-center gap-2"><Search size={17} className="shrink-0 text-muted" /><input autoFocus type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('rooms.gifSearch' as never)} className="min-w-0 flex-1 bg-transparent text-sm outline-none" /><button type="button" onClick={() => setOpen(false)} className="rounded-full p-1 text-muted hover:bg-zinc-100 dark:hover:bg-[#2d3148]" aria-label={t('rooms.emojiClose')}><X size={16} /></button></div>
      {loading && <p className="py-8 text-center text-sm text-muted">{t('rooms.gifLoading' as never)}</p>}
      {failed && <p className="py-8 text-center text-sm text-red-600">{t('rooms.gifLoadFailed' as never)}</p>}
      {!loading && !failed && items.length === 0 && <p className="py-8 text-center text-sm text-muted">{t('rooms.gifEmpty' as never)}</p>}
      {!loading && !failed && items.length > 0 && <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{items.map(item => <button key={item.id} type="button" onClick={() => choose(item)} className="overflow-hidden rounded-lg bg-zinc-100 dark:bg-[#272b3a]" title={item.title || item.name}><img src={`/api/v1/rooms/gifs/${item.file_id}/preview`} alt={item.title || item.name} loading="lazy" className="aspect-video w-full object-cover" onError={event => { event.currentTarget.style.display = 'none' }} /><span className="flex min-h-16 items-center justify-center px-2 text-xs">{item.title || item.name || <Image size={18} />}</span></button>)}</div>}
    </FloatingPanel>
  </span>
}