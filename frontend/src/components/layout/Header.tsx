import { Search, Moon, Sun, Menu, File, Folder, X } from 'lucide-react'
import { toggleTheme } from '@/lib/theme'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import type { FileItem, User } from '@/types/api'
import { formatBytes } from '@/lib/utils'
import { shouldOpenInOnlyOffice, shouldOpenInTextEditor } from '@/lib/file-types'
import { ignorePromise } from '@/lib/ignore-promise'

export function Header({ user, onMenuToggle }: { user?: User; onMenuToggle?: () => void }) {
  const [isDark, setIsDark] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FileItem[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const { t } = useI18n()

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'))
  }, [])

  const handleTheme = () => {
    const current: import('@/lib/theme').Theme = isDark ? 'dark' : 'light'
    toggleTheme(current)
    setIsDark(v => !v)
  }

  // Debounced search
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setResults([])
      setOpen(false)
      return
    }
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const data = await api.get<FileItem[]>(`/api/v1/files/search?q=${encodeURIComponent(trimmed)}`)
        setResults(data ?? [])
        setOpen(true)
        setActiveIdx(-1)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const openResult = useCallback((item: FileItem) => {
    setOpen(false)
    setQuery('')
    const folder = item.parent_id ?? undefined
    if (item.is_folder) {
      ignorePromise(navigate({ to: '/files', search: { folder: item.id } }))
    } else if (shouldOpenInOnlyOffice(item.name)) {
      ignorePromise(navigate({ to: '/files', search: { folder, oo: item.id, highlight: item.id } }))
    } else if (shouldOpenInTextEditor(item.name)) {
      ignorePromise(navigate({ to: '/files', search: { folder, te: item.id, highlight: item.id } }))
    } else {
      // Images, video, PDF etc — navigate to folder, scroll/highlight the row, open preview
      ignorePromise(navigate({ to: '/files', search: { folder, preview: item.id, highlight: item.id } }))
    }
  }, [navigate])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, -1))
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault()
      openResult(results[activeIdx])
    } else if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
    }
  }

  return (
    <header className="h-14 shrink-0 flex items-center gap-3 px-4 bg-white dark:bg-[#1a1d27] border-b border-zinc-200 dark:border-[#2d3148]">
      {/* Hamburger — mobile only */}
      <button
        onClick={onMenuToggle}
        aria-label="Toggle sidebar"
        className="p-2 rounded-lg text-zinc-500 dark:text-slate-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors md:hidden"
      >
        <Menu size={18} />
      </button>
      {/* Logo */}
      <img src="/logo_name.png" alt="Sharedrive" className="h-7 w-auto shrink-0" />

      {/* Search */}
      <div className="flex-1 max-w-md relative" ref={containerRef}>
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none z-10" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => { if (results.length > 0) setOpen(true) }}
          onKeyDown={handleKeyDown}
          placeholder={t('search.placeholder')}
          className="w-full pl-9 pr-8 py-1.5 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500/60"
        />
        {query && (
          <button
            onClick={() => { setQuery(''); setOpen(false); setResults([]) }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300 transition-colors"
          >
            <X size={13} />
          </button>
        )}

        {/* Results dropdown */}
        {open && (
          <div className="absolute left-0 right-0 top-full mt-1.5 rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] shadow-2xl z-50 overflow-hidden max-h-[60vh] overflow-y-auto">
            {loading && (
              <div className="px-4 py-3 text-xs text-zinc-400">{t('search.placeholder')}…</div>
            )}
            {!loading && results.length === 0 && (
              <div className="px-4 py-3 text-xs text-zinc-400">{t('search.noResults')}</div>
            )}
            {!loading && results.map((item, idx) => {
              const isOwn = item.owner_id === user?.id
              return (
                <button
                  key={item.id}
                  onClick={() => openResult(item)}
                  onMouseEnter={() => setActiveIdx(idx)}
                  className={`flex items-center gap-3 w-full px-4 py-2.5 text-left transition-colors ${
                    idx === activeIdx
                      ? 'bg-brand-50 dark:bg-brand-900/25'
                      : 'hover:bg-zinc-50 dark:hover:bg-[#2d3148]/60'
                  }`}
                >
                  {item.is_folder
                    ? <Folder size={16} className="shrink-0 text-yellow-500" />
                    : <File size={16} className="shrink-0 text-zinc-400" />
                  }
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-sm text-zinc-900 dark:text-slate-100">{item.name}</span>
                    <span className="text-[10px] text-zinc-400">
                      {isOwn ? t('search.myFiles') : t('search.sharedWith')}
                      {!item.is_folder && item.size_bytes > 0 && <> · {formatBytes(item.size_bytes)}</>}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 ml-auto">
        {/* Theme toggle */}
        <button
          onClick={handleTheme}
          aria-label="Toggle theme"
          className="p-2 rounded-lg text-zinc-500 dark:text-slate-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors"
        >
          {isDark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </header>
  )
}
