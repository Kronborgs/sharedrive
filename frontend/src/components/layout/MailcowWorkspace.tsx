import { Link, useNavigate } from '@tanstack/react-router'
import { CalendarDays, ContactRound, Mail, Settings } from 'lucide-react'
import { useState } from 'react'
import { Mailbox } from '@/components/mailcow/Mailbox'
import { MailCalendar } from '@/components/mailcow/Calendar'
import { MailContacts } from '@/components/mailcow/Contacts'
import { control, panel, type MailScope } from '@/components/mailcow/shared'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'
import { mailcowTabs, type MailcowTab } from '@/lib/mailcow'
import { cn } from '@/lib/utils'

const icons = { inbox: Mail, calendar: CalendarDays, contacts: ContactRound }

export function MailcowWorkspace({ userId, accountKey, username, tab, settings }: MailScope & Readonly<{
  username: string; tab: MailcowTab; settings: () => void
}>) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [recipient, setRecipient] = useState<string>()
  const scope = { userId, accountKey }

  return (
    <div className="flex min-h-[30rem] flex-col gap-2 lg:h-full lg:min-h-0">
      <header className={cn(panel, 'flex shrink-0 flex-wrap items-center gap-2 p-2.5')}>
        <nav aria-label={t('mailcowModule.title')} className="flex flex-wrap items-center gap-1 rounded-xl border border-subtle bg-(--app-bg)/65 p-1">
          {mailcowTabs.map(value => {
            const Icon = icons[value]
            return <Link key={value} to="/mail" search={{ view: value === 'inbox' ? undefined : value }} activeOptions={{ exact: true, includeSearch: true, explicitUndefined: true }} aria-current={value === tab ? 'page' : undefined}
              className={cn('flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium hover:bg-(--app-border)',
                value === tab && 'bg-brand-600 text-white hover:bg-brand-700')}>
              <Icon size={16} aria-hidden="true" />{t(value === 'inbox' ? 'mailcowModule.tab' : `mailcowWorkspace.${value}`)}
            </Link>
          })}
        </nav>
        <span className="ml-auto max-w-56 truncate px-2 text-xs text-muted">{username}</span>
        <button type="button" className={control} onClick={settings}><Settings size={16} />{t('mailcowAccount.title')}</button>
      </header>
      {tab === 'inbox' && <Mailbox scope={scope} recipient={recipient} />}
      {tab === 'calendar' && <MailCalendar scope={scope} username={username} />}
      {tab === 'contacts' && <MailContacts scope={scope} compose={email => {
        setRecipient(email)
        ignorePromise(navigate({ to: '/mail', search: {} }))
      }} />}
    </div>
  )
}
