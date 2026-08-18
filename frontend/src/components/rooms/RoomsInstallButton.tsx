import { PwaInstallButton } from '@/components/pwa/PwaInstallButton'
import { useI18n } from '@/lib/i18n'

export function RoomsInstallButton({ compact = false }: Readonly<{ compact?: boolean }>) {
  const { t } = useI18n()
  const label = t('rooms.installApp')
  return <PwaInstallButton className="notes-secondary-button shrink-0" title={label} label={<span className={compact ? 'hidden 2xl:inline' : undefined}>{label}</span>} />
}
