import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { useI18n } from '@/lib/i18n'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

export function NotesInstallButton({ className = 'notes-secondary-button' }: Readonly<{ className?: string }>) {
  const { locale } = useI18n()
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(() => getInstallPrompt())

  useEffect(() => {
    const refreshInstallPrompt = () => setInstallPrompt(getInstallPrompt())
    window.addEventListener('pwa-install-available', refreshInstallPrompt)
    window.addEventListener('pwa-install-changed', refreshInstallPrompt)
    return () => {
      window.removeEventListener('pwa-install-available', refreshInstallPrompt)
      window.removeEventListener('pwa-install-changed', refreshInstallPrompt)
    }
  }, [])

  if (!installPrompt || isStandalone()) return null

  return (
    <button className={className} onClick={() => {
      installPrompt.prompt().then(() => {
        clearInstallPrompt()
        setInstallPrompt(null)
      }).catch(() => undefined)
    }}>
      <Download size={17} />
      {locale === 'da' ? 'Installér Noter' : 'Install Notes'}
    </button>
  )
}

function getInstallPrompt() {
  return (window as Window & { __pwaInstallPrompt?: InstallPromptEvent }).__pwaInstallPrompt ?? null
}

function clearInstallPrompt() {
  delete (window as Window & { __pwaInstallPrompt?: InstallPromptEvent }).__pwaInstallPrompt
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
}
