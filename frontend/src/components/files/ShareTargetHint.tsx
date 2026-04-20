import { useState } from 'react'
import { X, Smartphone } from 'lucide-react'

const DISMISSED_KEY = 'sharedrive-share-hint-dismissed'

/**
 * A small dismissible hint button shown near the "My Files" heading.
 * Detects whether the app is running as an installed PWA (standalone mode)
 * and shows context-appropriate text:
 *   - Installed: "Del filer hertil direkte fra dit Android-galleri"
 *   - Browser: "Installér som app for at dele filer fra din mobil"
 */
export function ShareTargetHint() {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISSED_KEY) === '1',
  )

  if (dismissed) return null

  // Only show on touch-capable devices where this feature is relevant
  const isTouch =
    typeof window !== 'undefined' &&
    (navigator.maxTouchPoints > 0 || 'ontouchstart' in window)
  if (!isTouch) return null

  const isStandalone =
    typeof window !== 'undefined' &&
    window.matchMedia('(display-mode: standalone)').matches

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, '1')
    setDismissed(true)
  }

  return (
    <div className="flex items-center gap-2.5 px-4 py-2 border-b border-brand-200 dark:border-brand-800/40 bg-brand-50 dark:bg-brand-900/15 text-xs text-brand-700 dark:text-brand-300">
      <Smartphone size={14} className="shrink-0 text-brand-500" />
      <span className="flex-1 leading-snug">
        {isStandalone
          ? 'Del billeder hertil direkte fra Android-galleriet via Del-knappen.'
          : <>
              Installér som app — del billeder direkte hertil fra dit mobilgalleri.{' '}
              <button
                onClick={() => {
                  const event = (window as Window & { __pwaInstallPrompt?: { prompt: () => void } }).__pwaInstallPrompt
                  if (event) event.prompt()
                }}
                className="underline underline-offset-2 font-medium"
              >
                Installér
              </button>
            </>
        }
      </span>
      <button
        onClick={dismiss}
        className="shrink-0 p-0.5 text-brand-400 hover:text-brand-600 dark:hover:text-brand-200 transition-colors"
        title="Skjul"
      >
        <X size={14} />
      </button>
    </div>
  )
}
