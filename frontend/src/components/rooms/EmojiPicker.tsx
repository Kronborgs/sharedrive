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

interface EmojiCategory {
  id: string
  icon: string
  label: string
}

const fallbackEmojis = ['👍', '❤️', '😂', '😊', '🎉', '🙏', '😍', '👏', '🔥', '✅']
const pageSize = 160
const categories: EmojiCategory[] = [
  { id: 'frequent', icon: '🕘', label: 'Mest brugte' },
  { id: 'smileys-emotion', icon: '😀', label: 'Smileys og følelser' },
  { id: 'people-body', icon: '👋', label: 'Personer og krop' },
  { id: 'animals-nature', icon: '🐻', label: 'Dyr og natur' },
  { id: 'food-drink', icon: '🍕', label: 'Mad og drikke' },
  { id: 'activities', icon: '⚽', label: 'Aktiviteter' },
  { id: 'travel-places', icon: '🚗', label: 'Rejser og steder' },
  { id: 'objects', icon: '💡', label: 'Ting' },
  { id: 'symbols', icon: '❤️', label: 'Symboler' },
  { id: 'flags', icon: '🏳️', label: 'Flag' },
  { id: 'extras-unicode', icon: '✨', label: 'Ekstra' },
]
let catalogPromise: Promise<OpenMojiEntry[]> | undefined

function loadCatalog(): Promise<OpenMojiEntry[]> {
  catalogPromise ??= import('openmoji/data/openmoji.json').then(module => {
    const unique = new Map<string, OpenMojiEntry>()
    for (const entry of module.default as OpenMojiEntry[]) {
      if (entry.emoji && entry.group !== 'extras-openmoji' && entry.group !== 'component' && !unique.has(entry.emoji)) unique.set(entry.emoji, entry)
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

function asEntries(emojis: string[]): OpenMojiEntry[] {
  return emojis.map(emoji => ({ emoji, annotation: emoji, tags: '', group: 'frequent' }))
}

function EmojiGrid({ entries, onChoose }: Readonly<{ entries: OpenMojiEntry[]; onChoose: (emoji: string) => void }>) {
  return <div className="grid grid-cols-8 gap-1 sm:grid-cols-10">
    {entries.map(entry => <button key={entry.emoji} type="button" onClick={() => onChoose(entry.emoji)} className="flex aspect-square items-center justify-center rounded-lg text-2xl hover:bg-zinc-100 focus-visible:bg-zinc-100 dark:hover:bg-[#2d3148] dark:focus-visible:bg-[#2d3148]" title={entry.annotation}>{entry.emoji}</button>)}
  </div>
}

function CategoryBar({ active, onSelect }: Readonly<{ active: string; onSelect: (id: string) => void }>) {
  return <div className="mb-3 flex gap-1 overflow-x-auto border-b border-zinc-200 pb-2 dark:border-[#34394f]" aria-label="Emoji-emner">
    {categories.map(category => <button key={category.id} type="button" onClick={() => onSelect(category.id)} aria-label={category.label} title={category.label} className={`shrink-0 rounded-lg px-2 py-1.5 text-xl ${active === category.id ? 'bg-brand-100 ring-1 ring-brand-400 dark:bg-brand-950/50' : 'hover:bg-zinc-100 dark:hover:bg-[#2d3148]'}`}>{category.icon}</button>)}
  </div>
}

export function EmojiPicker({ userKey, onSelect, label = 'Vælg emoji' }: Readonly<{ userKey: string; onSelect: (emoji: string) => void; label?: string }>) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState('frequent')
  const [visibleCount, setVisibleCount] = useState(pageSize)
  const [catalog, setCatalog] = useState<OpenMojiEntry[]>([])
  const [usage, setUsage] = useState<EmojiUsage[]>(() => readUsage(userKey))

  useEffect(() => setUsage(readUsage(userKey)), [userKey])
  useEffect(() => {
    if (open && catalog.length === 0) loadCatalog().then(setCatalog).catch(() => setCatalog([]))
  }, [catalog.length, open])
  useEffect(() => setVisibleCount(pageSize), [activeCategory, query])

  const frequent = usage.length > 0 ? usage.slice(0, 10).map(item => item.emoji) : fallbackEmojis
  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (needle) return catalog.filter(entry => `${entry.emoji} ${entry.annotation} ${entry.tags}`.toLocaleLowerCase().includes(needle))
    if (activeCategory === 'frequent') return asEntries(frequent)
    return catalog.filter(entry => entry.group === activeCategory)
  }, [activeCategory, catalog, frequent, query])
  const visibleResults = results.slice(0, visibleCount)
  const activeLabel = query ? 'Søgeresultater' : categories.find(category => category.id === activeCategory)?.label
  const choose = (emoji: string) => {
    setUsage(recordUsage(userKey, emoji))
    onSelect(emoji)
    setOpen(false)
    setQuery('')
  }

  return <span className="inline-flex">
    <button ref={buttonRef} type="button" onClick={() => setOpen(value => !value)} className="rounded-full p-2 text-muted hover:bg-zinc-100 dark:hover:bg-[#2d3148]" aria-label={label} title={label} aria-expanded={open}><SmilePlus size={19} /></button>
    <FloatingPanel anchorRef={buttonRef} open={open} onOpenChange={setOpen} ariaLabel={label} className="w-[min(23rem,calc(100vw-1rem))] p-3">
      <div className="mb-3 flex items-center gap-2">
        <Search size={17} className="shrink-0 text-muted" />
        <input autoFocus type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Søg efter emoji…" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
        <button type="button" onClick={() => setOpen(false)} className="rounded-full p-1 text-muted hover:bg-zinc-100 dark:hover:bg-[#2d3148]" aria-label="Luk emoji-vælger"><X size={16} /></button>
      </div>
      <CategoryBar active={activeCategory} onSelect={setActiveCategory} />
      <section aria-label={activeLabel}><p className="mb-1.5 text-xs font-medium text-muted">{activeLabel}</p><EmojiGrid entries={visibleResults} onChoose={choose} /></section>
      {catalog.length === 0 && activeCategory !== 'frequent' && <p className="py-5 text-center text-xs text-muted">Indlæser OpenMoji-katalog…</p>}
      {visibleResults.length < results.length && <button type="button" onClick={() => setVisibleCount(count => count + pageSize)} className="mt-3 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-[#34394f] dark:hover:bg-[#2d3148]">Vis flere ({results.length - visibleResults.length})</button>}
      <p className="mt-4 border-t border-zinc-200 pt-3 text-center text-[11px] text-muted dark:border-[#34394f]">Emoji-katalog: <a href="https://openmoji.org/" target="_blank" rel="noreferrer" className="underline">OpenMoji</a> (CC BY-SA 4.0).</p>
    </FloatingPanel>
  </span>
}