import { useEffect, useState, type ReactNode } from 'react'
import { Download } from 'lucide-react'

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

interface PwaInstallButtonProps {
  label: ReactNode
  title: string
  className: string
  iconSize?: number
}

export function PwaInstallButton({ label, title, className, iconSize = 17 }: Readonly<PwaInstallButtonProps>) {
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
    <button type="button" className={className} title={title} onClick={() => {
      installPrompt.prompt().then(() => {
        clearInstallPrompt()
        setInstallPrompt(null)
      }).catch(() => undefined)
    }}>
      <Download size={iconSize} />
      {label}
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
