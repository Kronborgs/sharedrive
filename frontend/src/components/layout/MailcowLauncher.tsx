import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import type { MailcowTab } from '@/lib/mailcow'
import { consumeShareMailDraft } from '@/lib/share-mail-draft'
import { MailcowWorkspace } from './MailcowWorkspace'

const suiteHome = '/mail/suite-ui/'

function suiteView(tab: MailcowTab) {
  return tab === 'inbox' ? 'mail' : tab
}

export function MailcowLauncher({ userId, accountKey, username, tab, settings, onTabChange, onClose }: Readonly<{
  userId: string; accountKey: string; username: string; tab: MailcowTab
  settings: () => void
  onTabChange: (tab: MailcowTab) => void
  onClose: () => void
}>) {
  const { t } = useI18n()
  const iframe = useRef<HTMLIFrameElement>(null)
  const [initialTab] = useState(tab)
  const [frameSource, setFrameSource] = useState<string>()
  const [fallback, setFallback] = useState<{ draft: ReturnType<typeof consumeShareMailDraft> }>()

  useEffect(() => {
    const controller = new AbortController()
    function showFallback() {
      if (!controller.signal.aborted) setFallback({ draft: initialTab === 'inbox' ? consumeShareMailDraft() : undefined })
    }
    async function open() {
      try {
        const response = await fetch(suiteHome, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok || !(await response.text()).includes('name="sharedrive-mail-suite"')) {
          showFallback()
          return
        }
        const target = new URL(suiteHome, window.location.origin)
        target.searchParams.set('view', suiteView(initialTab))
        if (initialTab === 'inbox') target.hash = window.location.hash
        if (!controller.signal.aborted) setFrameSource(target.href)
      } catch {
        showFallback()
      }
    }
    void open()
    return () => controller.abort()
  }, [initialTab])

  useEffect(() => {
    const sendView = () => iframe.current?.contentWindow?.postMessage(
      { type: 'sharedrive-mail-view', view: suiteView(tab) },
      window.location.origin,
    )
    function receive(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== iframe.current?.contentWindow) return
      const message = event.data
      switch (message?.type) {
        case 'sharedrive-mail-ready':
          sendView()
          if (initialTab === 'inbox') consumeShareMailDraft()
          break
        case 'sharedrive-mail-view':
          if (message.view === 'mail') onTabChange('inbox')
          if (message.view === 'calendar' || message.view === 'contacts') onTabChange(message.view)
          break
        case 'sharedrive-mail-settings':
          settings()
          break
        case 'sharedrive-mail-close':
          onClose()
          break
      }
    }
    window.addEventListener('message', receive)
    sendView()
    return () => window.removeEventListener('message', receive)
  }, [frameSource, initialTab, tab, onTabChange, onClose, settings])

  if (fallback) return <MailcowWorkspace userId={userId} accountKey={accountKey} username={username} tab={tab} settings={settings} draft={fallback.draft} />
  if (!frameSource) return <p className="p-4 text-sm text-muted">{t('settings.loading')}</p>

  return <iframe ref={iframe} src={frameSource} title={t('mailcowModule.title')} className="block h-full min-h-0 w-full rounded-xl border border-subtle bg-surface" />
}
