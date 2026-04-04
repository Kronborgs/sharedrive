import { APP_VERSION } from '@/version'

export function Footer() {
  return (
    <footer className="shrink-0 px-4 py-2 border-t border-zinc-100 dark:border-[#2d3148] flex items-center justify-end">
      <span className="text-xs text-zinc-400 dark:text-slate-600 select-none">
        Sharedrive {APP_VERSION}
      </span>
    </footer>
  )
}
