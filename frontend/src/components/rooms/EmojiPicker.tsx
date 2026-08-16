import { useEffect, useMemo, useState } from 'react'
import { Search, SmilePlus, X } from 'lucide-react'

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

export function EmojiPicker({ userKey, onSelect, label = 'Vælg emoji' }: Readonly<{ userKey: string; onSelect: (emoji: string) => void; label?: string }>) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<OpenMojiEntry[]>([])
  const [usage, setUsage] = useState<EmojiUsage[]>(() => readUsage(userKey))

  useEffect(() => {
    setUsage(readUsage(userKey))
  }, [userKey])

  useEffect(() => {
    if (open && catalog.length === 0) loadCatalog().then(setCatalog).catch(() => setCatalog([]))
  }, [catalog.length, open])

  const top = usage.length > 0 ? usage.slice(0, 10).map(item => item.emoji) : fallbackEmojis
  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return catalog.slice(0, 120)
    return catalog.filter(entry => `${entry.emoji} ${entry.annotation} ${entry.tags}`.toLocaleLowerCase().includes(needle)).slice(0, 120)
  }, [catalog, query])
  const choose = (emoji: string) => {
    setUsage(recordUsage(userKey, emoji))
    onSelect(emoji)
    setOpen(false)
    setQuery('')
  }

  return <span className="relative inline-flex">
    <button type="button" onClick={() => setOpen(value => !value)} className="rounded-md p-1.5 text-muted hover:bg-zinc-100 dark:hover:bg-[#2d3148]" aria-label={label} title={label}><SmilePlus size={17} /></button>
    {open && <span className="absolute bottom-full right-0 z-40 mb-2 block w-80 rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-[#2d3148] dark:bg-[#1a1d27]">
      <span className="mb-2 flex items-center gap-2"><Search size={15} className="text-muted" /><input autoFocus type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Søg emoji (fx smile, heart)…" className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-[#3a3f58]" /><button type="button" onClick={() => setOpen(false)} aria-label="Luk emoji-vælger"><X size={15} /></button></span>
      {!query && <><span className="mb-1 block text-xs font-medium text-muted">Dine mest brugte</span><span className="mb-3 grid grid-cols-10 gap-1">{top.map(emoji => <button key={emoji} type="button" onClick={() => choose(emoji)} className="rounded p-1 text-xl hover:bg-zinc-100 dark:hover:bg-[#2d3148]">{emoji}</button>)}</span></>}
      <span className="grid max-h-64 grid-cols-10 gap-1 overflow-y-auto">{results.map(entry => <button key={entry.emoji} type="button" onClick={() => choose(entry.emoji)} className="rounded p-1 text-xl hover:bg-zinc-100 dark:hover:bg-[#2d3148]" title={entry.annotation}>{entry.emoji}</button>)}</span>
      {catalog.length === 0 && <span className="block py-4 text-center text-xs text-muted">Indlæser OpenMoji-katalog…</span>}
    </span>}
  </span>
}
