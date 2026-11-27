import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import type { MailcowTab } from '@/lib/mailcow'
import { MailcowWorkspace } from './MailcowWorkspace'

const suiteHome = '/mail/suite-ui/'

export function MailcowLauncher(props: Readonly<{
  userId: string; accountKey: string; username: string; tab: MailcowTab; settings: () => void
}>) {
  const { t } = useI18n()
  const [fallback, setFallback] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const target = new URL(suiteHome, window.location.origin)
    target.searchParams.set('view', props.tab === 'inbox' ? 'mail' : props.tab)
    async function open() {
      try {
        const response = await fetch(suiteHome, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok || !(await response.text()).includes('name="sharedrive-mail-suite"')) {
          if (!controller.signal.aborted) setFallback(true)
          return
        }
        if (!controller.signal.aborted) window.location.replace(target)
      } catch {
        if (!controller.signal.aborted) setFallback(true)
      }
    }
    void open()
    return () => controller.abort()
  }, [props.tab])

  if (fallback) return <MailcowWorkspace {...props} />
  return <p className="p-4 text-sm text-muted">{t('settings.loading')}</p>
}
