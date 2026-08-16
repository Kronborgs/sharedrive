import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, SmilePlus, X } from 'lucide-react'
import { FloatingPanel } from '@/components/rooms/FloatingPanel'

interface OpenMojiEntry {
  emoji: string
  annotation: string
  tags: string
  group: string
}

interface EmojiUsage {
  emoji: string
  count: number
  lastUsed: number
}

const fallbackEmojis = ['👍', '❤️', '😂', '😊', '🎉', '🙏', '😍', '👏', '🔥', '✅']
let catalogPromise: Promise<OpenMojiEntry[]> | undefined

function loadCatalog(): Promise<OpenMojiEntry[]> {
  catalogPromise ??= import('openmoji/data/openmoji.json').then(module => {
    const unique = new Map<string, OpenMojiEntry>()
    for (const entry of module.default as OpenMojiEntry[]) {
      if (entry.emoji && entry.group !== 'extras-openmoji' && !unique.has(entry.emoji)) unique.set(entry.emoji, entry)
    }
    return [...unique.values()]
  })
  return catalogPromise
}

function usageKey(userKey: string) {
  return `rooms:emoji-usage:${userKey}`
}

function readUsage(userKey: string): EmojiUsage[] {
  try {
    return JSON.parse(localStorage.getItem(usageKey(userKey)) ?? '[]') as EmojiUsage[]
  } catch {
    return []
  }
}

function recordUsage(userKey: string, emoji: string): EmojiUsage[] {
  const usage = readUsage(userKey)
  const existing = usage.find(item => item.emoji === emoji)
  if (existing) {
    existing.count += 1
    existing.lastUsed = Date.now()
  } else {
    usage.push({ emoji, count: 1, lastUsed: Date.now() })
  }
  usage.sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed)
  const trimmed = usage.slice(0, 50)
  localStorage.setItem(usageKey(userKey), JSON.stringify(trimmed))
  return trimmed
}

function EmojiGrid({ entries, onChoose }: Readonly<{ entries: OpenMojiEntry[]; onChoose: (emoji: string) => void }>) {
  return <div className="grid grid-cols-8 gap-1 sm:grid-cols-10">
    {entries.map(entry => <button key={entry.emoji} type="button" onClick={() => onChoose(entry.emoji)} className="flex aspect-square items-center justify-center rounded-lg text-2xl hover:bg-zinc-100 focus-visible:bg-zinc-100 dark:hover:bg-[#2d3148] dark:focus-visible:bg-[#2d3148]" title={entry.annotation}>{entry.emoji}</button>)}
  </div>
}

export function EmojiPicker({ userKey, onSelect, label = 'Vælg emoji' }: Readonly<{ userKey: string; onSelect: (emoji: string) => void; label?: string }>) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<OpenMojiEntry[]>([])
  const [usage, setUsage] = useState<EmojiUsage[]>(() => readUsage(userKey))

  useEffect(() => setUsage(readUsage(userKey)), [userKey])
  useEffect(() => {
    if (open && catalog.length === 0) loadCatalog().then(setCatalog).catch(() => setCatalog([]))
  }, [catalog.length, open])

  const top = usage.length > 0 ? usage.slice(0, 10).map(item => item.emoji) : fallbackEmojis
  const topEntries = top.map(emoji => ({ emoji, annotation: emoji, tags: '', group: '' }))
  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return catalog.slice(0, 160)
    return catalog.filter(entry => `${entry.emoji} ${entry.annotation} ${entry.tags}`.toLocaleLowerCase().includes(needle)).slice(0, 160)
  }, [catalog, query])
  const choose = (emoji: string) => {
    setUsage(recordUsage(userKey, emoji))
    onSelect(emoji)
    setOpen(false)
    setQuery('')
  }

  return <span className="inline-flex">
    <button ref={buttonRef} type="button" onClick={() => setOpen(value => !value)} className="rounded-full p-2 text-muted hover:bg-zinc-100 dark:hover:bg-[#2d3148]" aria-label={label} title={label} aria-expanded={open}><SmilePlus size={19} /></button>
    <FloatingPanel anchorRef={buttonRef} open={open} onOpenChange={setOpen} ariaLabel={label} className="w-[min(22rem,calc(100vw-1rem))] p-3">
      <div className="mb-3 flex items-center gap-2 border-b border-zinc-200 pb-3 dark:border-[#34394f]">
        <Search size={17} className="shrink-0 text-muted" />
        <input autoFocus type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Søg efter emoji…" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
        <button type="button" onClick={() => setOpen(false)} className="rounded-full p-1 text-muted hover:bg-zinc-100 dark:hover:bg-[#2d3148]" aria-label="Luk emoji-vælger"><X size={16} /></button>
      </div>
      {!query && <section className="mb-3" aria-label="Mest brugte emojis"><p className="mb-1.5 text-xs font-medium text-muted">Mest brugte</p><EmojiGrid entries={topEntries} onChoose={choose} /></section>}
      <section aria-label="Alle emojis"><p className="mb-1.5 text-xs font-medium text-muted">{query ? 'Søgeresultater' : 'Alle emojis'}</p><EmojiGrid entries={results} onChoose={choose} /></section>
      {catalog.length === 0 && <p className="py-5 text-center text-xs text-muted">Indlæser OpenMoji-katalog…</p>}
    </FloatingPanel>
  </span>
}