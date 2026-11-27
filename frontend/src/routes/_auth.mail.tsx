import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { MailcowAccountDialog } from '@/components/layout/MailcowAccountDialog'
import { MailcowLauncher } from '@/components/layout/MailcowLauncher'
import { useAuth } from '@/lib/auth-context'
import { useI18n } from '@/lib/i18n'
import { useMailcowAccount, useMailcowNavigation, type MailcowTab } from '@/lib/mailcow'

export const Route = createFileRoute('/_auth/mail')({
  validateSearch: (search: Record<string, unknown>): { view?: MailcowTab; manage?: boolean } => ({
    view: search.view === 'calendar' || search.view === 'contacts' ? search.view : undefined,
    manage: search.manage === true || undefined,
  }),
  component: MailPage,
})

function MailPage() {
  const { user } = useAuth()
  const { t } = useI18n()
  const { view = 'inbox', manage } = Route.useSearch()
  const navigate = Route.useNavigate()
  const feature = useMailcowNavigation(user)
  const account = useMailcowAccount(user?.id, feature.enabled)
  const [showSettings, setShowSettings] = useState(false)
  const closeSettings = () => {
    setShowSettings(false)
    if (manage) void navigate({ search: { view }, replace: true })
  }

  if (!user || feature.loading) return <p className="p-4 text-sm text-muted">{t('settings.loading')}</p>
  if (!feature.enabled || !account.data?.ready) return <p className="p-4 text-sm text-muted">{t('mailcowAccount.disabled')}</p>

  const linked = account.data.account
  const accountKey = linked ? linked.host + '/' + linked.username : ''
  return (
    <>
      {linked && !manage ? (
        <MailcowLauncher key={user.id + '/' + accountKey} userId={user.id} accountKey={accountKey} username={linked.username} tab={view} settings={() => setShowSettings(true)} />
      ) : (
        <section className="rounded-2xl border border-subtle bg-surface p-5">
          <h1 className="text-lg font-semibold">{t('mailcowModule.setupTitle')}</h1>
          <button type="button" className="mt-3 rounded-lg bg-brand-600 px-3 py-2 text-sm text-white" onClick={() => setShowSettings(true)}>
            {t('mailcowModule.setupContinue')}
          </button>
        </section>
      )}
      {(showSettings || manage) && <MailcowAccountDialog userId={user.id} close={closeSettings} />}
    </>
  )
}
