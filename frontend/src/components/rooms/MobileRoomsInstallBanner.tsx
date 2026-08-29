import { PwaInstallButton } from '@/components/pwa/PwaInstallButton'
import { useI18n } from '@/lib/i18n'

/** A compact mobile-only entry point to the existing Rooms PWA installation flow. */
export function MobileRoomsInstallBanner() {
  const { t } = useI18n()
  const label = t('rooms.installBanner' as never)
  const installed = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
  if (installed) return null
  return <div className="mb-2 md:hidden"><PwaInstallButton className="flex w-full items-center justify-center gap-2 rounded-lg border border-brand-500/40 bg-brand-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500" title={label} unavailableMessage={t('rooms.installAppHelp' as never)} label={<span>{label}</span>} /></div>
}
