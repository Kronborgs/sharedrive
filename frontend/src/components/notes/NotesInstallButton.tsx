import { useI18n } from '@/lib/i18n'
import { PwaInstallButton } from '@/components/pwa/PwaInstallButton'

export function NotesInstallButton({ className = 'notes-secondary-button' }: Readonly<{ className?: string }>) {
  const { locale } = useI18n()
  const label = locale === 'da' ? 'Installér Noter' : 'Install Notes'
  return <PwaInstallButton className={className} title={label} label={label} />
}
