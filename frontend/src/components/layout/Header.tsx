import { Search, Moon, Sun } from 'lucide-react'
import { toggleTheme } from '@/lib/theme'
import { useState, useEffect } from 'react'

export function Header() {
  const [isDark, setIsDark] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'))
  }, [])

  const handleTheme = () => {
    toggleTheme()
    setIsDark(v => !v)
  }

  return (
    <header className="h-14 shrink-0 flex items-center gap-3 px-4 bg-white dark:bg-[#1a1d27] border-b border-zinc-200 dark:border-[#2d3148]">
      {/* Logo */}
      <img src="/logo_name.png" alt="Sharedrive" className="h-7 w-auto shrink-0" />
      {/* Search */}
      <div className="flex-1 max-w-md relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search files…"
          className="w-full pl-9 pr-3 py-1.5 text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500/60"
        />
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
