import { PwaInstallButton } from '@/components/pwa/PwaInstallButton'
import { useI18n } from '@/lib/i18n'

export function RoomsInstallButton({ compact = false }: Readonly<{ compact?: boolean }>) {
  const { t } = useI18n()
  const label = t('rooms.installApp')
  return <PwaInstallButton className="rooms-toolbar-button" title={label} unavailableMessage={t('rooms.installAppHelp' as never)} label={<span className={compact ? 'hidden min-[1360px]:inline' : undefined}>{label}</span>} />
}
