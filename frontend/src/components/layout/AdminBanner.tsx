import { ShieldCheck, X } from 'lucide-react'
import { useAdminBanner } from '@/hooks/useAdminBanner'

export function AdminBanner() {
  const { active, targetUser, dismiss } = useAdminBanner()

  if (!active) return null

  return (
    <div className="shrink-0 bg-amber-500 dark:bg-amber-600 text-white px-4 py-2 flex items-center gap-2 text-sm font-medium">
      <ShieldCheck size={15} className="shrink-0" />
      <span>
        Admin support session — viewing as <strong>{targetUser}</strong>. All actions are recorded.
      </span>
      <button
        onClick={dismiss}
        aria-label="Dismiss banner"
        className="ml-auto p-0.5 rounded hover:bg-amber-600/40 dark:hover:bg-amber-700/40 transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  )
}
