import { ShieldCheck, X } from 'lucide-react'
import { useAdminBanner } from '@/hooks/useAdminBanner'
import { useI18n } from '@/lib/i18n'

export function AdminBanner() {
  const { active, targetUser, dismiss } = useAdminBanner()
  const { t } = useI18n()

  if (!active) return null

  return (
    <div className="shrink-0 bg-amber-500 dark:bg-amber-600 text-white px-4 py-2 flex items-center gap-2 text-sm font-medium">
      <ShieldCheck size={15} className="shrink-0" />
      <span
        dangerouslySetInnerHTML={{
          __html: t('banner.adminSession', { user: `<strong>${targetUser}</strong>` }),
        }}
      />
      <button
        onClick={dismiss}
        aria-label={t('banner.dismiss')}
        className="ml-auto p-0.5 rounded hover:bg-amber-600/40 dark:hover:bg-amber-700/40 transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  )
}
