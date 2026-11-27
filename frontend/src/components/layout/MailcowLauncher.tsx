import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import type { MailcowTab } from '@/lib/mailcow'
import { consumeShareMailDraft } from '@/lib/share-mail-draft'
import { MailcowWorkspace } from './MailcowWorkspace'

const suiteHome = '/mail/suite-ui/'

export function MailcowLauncher(props: Readonly<{
  userId: string; accountKey: string; username: string; tab: MailcowTab; settings: () => void
}>) {
  const { t } = useI18n()
  const [fallback, setFallback] = useState<{ draft: ReturnType<typeof consumeShareMailDraft> }>()

  useEffect(() => {
    const controller = new AbortController()
    const target = new URL(suiteHome, window.location.origin)
    target.searchParams.set('view', props.tab === 'inbox' ? 'mail' : props.tab)
    if (props.tab === 'inbox') target.hash = window.location.hash
    function showFallback() {
      if (!controller.signal.aborted) setFallback({ draft: props.tab === 'inbox' ? consumeShareMailDraft() : undefined })
    }
    async function open() {
      try {
        const response = await fetch(suiteHome, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok || !(await response.text()).includes('name="sharedrive-mail-suite"')) {
          showFallback()
          return
        }
        if (!controller.signal.aborted) window.location.replace(target)
      } catch {
        showFallback()
      }
    }
    void open()
    return () => controller.abort()
  }, [props.tab])

  if (fallback) return <MailcowWorkspace {...props} draft={fallback.draft} />
  return <p className="p-4 text-sm text-muted">{t('settings.loading')}</p>
}
