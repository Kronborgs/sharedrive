import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'

const endpoint = '/api/v1/me/mailcow'
const input = 'w-full rounded-lg border border-subtle bg-(--app-bg) px-3 py-2 text-sm'
const button = 'rounded-lg border border-subtle px-3 py-2 text-sm hover:bg-(--app-bg) disabled:opacity-50'
type AccountProps = Readonly<{ userId: string; accountKey: string }>
type Message = { uid: number; subject: string; from: string; date: string }
type CalendarEvent = { id: string; title: string; start: string; end: string; allDay: boolean }
type Contact = { id: string; name: string; email: string; phone: string }
type Tab = 'inbox' | 'calendar' | 'contacts'

function useMailList<T>({ userId, accountKey }: AccountProps, path: string) {
  return useQuery({
    queryKey: ['mailcow-content', userId, accountKey, path],
    queryFn: ({ signal }) => api.get<T>(endpoint + '/' + path, signal),
    retry: false,
  })
}

function field(data: FormData, name: string) {
  const value = data.get(name)
  return typeof value === 'string' ? value : ''
}

function Entry({ name, label, type = 'text', required = true }: Readonly<{ name: string; label: string; type?: string; required?: boolean }>) {
  return <label className="block space-y-1 text-sm"><span>{label}</span><input name={name} type={type} required={required} className={input} /></label>
}

function useWrite(onSaved?: () => void) {
  const [status, setStatus] = useState<'pending' | 'ok' | 'error' | null>(null)
  function submit(event: FormEvent<HTMLFormElement>, path: string, values: (data: FormData) => Record<string, string>) {
    event.preventDefault()
    if (status === 'pending') return
    const form = event.currentTarget
    const data = new FormData(form)
    setStatus('pending')
    ignorePromise((async () => {
      try {
        await api.post(endpoint + '/' + path, values(data))
        form.reset()
        setStatus('ok')
        onSaved?.()
      } catch {
        setStatus('error')
      }
    })())
  }
  return { status, submit }
}

function WriteResult({ status }: Readonly<{ status: ReturnType<typeof useWrite>['status'] }>) {
  const { t } = useI18n()
  if (status === 'error') return <p role="alert" className="text-sm text-red-400">{t('mailcowAccount.failed')}</p>
  if (status === 'ok') return <p role="status" className="text-sm text-emerald-400">{t('mailcowWorkspace.done')}</p>
  return null
}

function ListState({ pending, error, empty }: Readonly<{ pending: boolean; error: boolean; empty: boolean }>) {
  const { t } = useI18n()
  if (error) return <p role="alert" className="text-sm text-red-400">{t('mailcowAccount.failed')}</p>
  if (pending) return <p className="text-sm text-muted">{t('settings.loading')}</p>
  if (empty) return <p className="text-sm text-muted">{t('mailcowWorkspace.empty')}</p>
  return null
}

function Inbox(props: AccountProps) {
  const { t } = useI18n()
  const list = useMailList<Message[]>(props, 'inbox')
  const [uid, setUid] = useState<number | null>(null)
  const [compose, setCompose] = useState(false)
  const message = useQuery({
    queryKey: ['mailcow-content', props.userId, props.accountKey, 'message', uid],
    queryFn: () => api.post<{ subject: string; text: string }>(endpoint + '/message', { uid }),
    enabled: uid !== null,
    retry: false,
  })
  const write = useWrite()
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button type="button" className={button} onClick={() => setCompose(value => !value)} aria-expanded={compose}>{t('mailcowWorkspace.compose')}</button>
        <button type="button" className={button} onClick={() => ignorePromise(list.refetch())}>{t('mailcowWorkspace.refresh')}</button>
      </div>
      {compose && <form className="space-y-2 rounded-xl border border-subtle p-3" onSubmit={(event) => write.submit(event, 'send', data => ({
        to: field(data, 'to'), subject: field(data, 'subject'), body: field(data, 'body'),
      }))}>
        <Entry name="to" type="email" label={t('mailcowWorkspace.to')} />
        <Entry name="subject" label={t('mailcowWorkspace.subject')} />
        <label className="block space-y-1 text-sm"><span>{t('mailcowWorkspace.body')}</span><textarea name="body" required rows={4} maxLength={24_000} className={input} /></label>
        <button type="submit" disabled={write.status === 'pending'} className={button}>{t('mailcowWorkspace.send')}</button>
        <WriteResult status={write.status} />
      </form>}
      <ListState pending={list.isPending} error={list.isError} empty={list.data?.length === 0} />
      {list.data?.map(item => (
        <button key={item.uid} type="button" aria-pressed={uid === item.uid} className="block w-full rounded-lg border border-subtle p-2 text-left text-sm hover:bg-(--app-bg)" onClick={() => setUid(item.uid)}>
          <span className="block break-words font-medium">{item.subject || t('mailcowWorkspace.noSubject')}</span>
          <span className="break-all text-xs text-muted">{item.from}</span>
        </button>
      ))}
      {uid !== null && (
        <section className="space-y-2 rounded-xl border border-subtle p-3" aria-live="polite">
          <ListState pending={message.isPending} error={message.isError} empty={false} />
          {message.data && <>
            <h3 className="font-semibold">{message.data.subject || t('mailcowWorkspace.noSubject')}</h3>
            <p className="whitespace-pre-wrap break-words text-sm">{message.data.text || t('mailcowWorkspace.noText')}</p>
          </>}
        </section>
      )}
    </div>
  )
}

function Calendar(props: AccountProps) {
  const { t, locale } = useI18n()
  const list = useMailList<CalendarEvent[]>(props, 'calendar')
  const write = useWrite(() => ignorePromise(list.refetch()))
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">{t('mailcowWorkspace.calendarRange')}</p>
      <ListState pending={list.isPending} error={list.isError} empty={list.data?.length === 0} />
      {list.data?.map(item => <div key={item.id + item.start} className="rounded-lg border border-subtle p-2 text-sm">
        <p className="font-medium">{item.title || t('mailcowWorkspace.noSubject')}</p>
        <p className="text-muted">{item.allDay ? item.start : new Date(item.start).toLocaleString(locale)}</p>
      </div>)}
      <form className="space-y-2 rounded-xl border border-subtle p-3" onSubmit={(event) => write.submit(event, 'event', data => ({
        title: field(data, 'title'), start: new Date(field(data, 'start')).toISOString(), end: new Date(field(data, 'end')).toISOString(),
      }))}>
        <Entry name="title" label={t('mailcowWorkspace.eventTitle')} />
        <div className="grid gap-2 sm:grid-cols-2">
          <Entry name="start" type="datetime-local" label={t('mailcowWorkspace.start')} />
          <Entry name="end" type="datetime-local" label={t('mailcowWorkspace.end')} />
        </div>
        <button type="submit" className={button} disabled={write.status === 'pending'}>{t('mailcowWorkspace.addEvent')}</button>
        <WriteResult status={write.status} />
      </form>
    </div>
  )
}

function Contacts(props: AccountProps) {
  const { t } = useI18n()
  const list = useMailList<Contact[]>(props, 'contacts')
  const write = useWrite(() => ignorePromise(list.refetch()))
  return (
    <div className="space-y-3">
      <ListState pending={list.isPending} error={list.isError} empty={list.data?.length === 0} />
      {list.data?.map(item => <div key={item.id} className="rounded-lg border border-subtle p-2 text-sm">
        <p className="font-medium">{item.name}</p>
        <p className="break-all text-muted">{[item.email, item.phone].filter(Boolean).join(' · ')}</p>
      </div>)}
      <form className="space-y-2 rounded-xl border border-subtle p-3" onSubmit={(event) => write.submit(event, 'contact', data => ({
        name: field(data, 'name'), email: field(data, 'email'), phone: field(data, 'phone'),
      }))}>
        <Entry name="name" label={t('mailcowWorkspace.name')} />
        <Entry name="email" type="email" required={false} label={t('login.email')} />
        <Entry name="phone" type="tel" required={false} label={t('mailcowWorkspace.phone')} />
        <button type="submit" className={button} disabled={write.status === 'pending'}>{t('mailcowWorkspace.addContact')}</button>
        <WriteResult status={write.status} />
      </form>
    </div>
  )
}

const tabs = ['inbox', 'calendar', 'contacts'] as const

export function MailcowWorkspace(props: AccountProps & Readonly<{ settings: () => void }>) {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('inbox')
  return (
    <div className="mt-4 space-y-3">
      <nav className="flex flex-wrap gap-2" aria-label={t('mailcowModule.title')}>
        {tabs.map(value => <button key={value} type="button" aria-pressed={tab === value} className={button} onClick={() => setTab(value)}>{t(`mailcowWorkspace.${value}`)}</button>)}
        <button type="button" className={button} onClick={props.settings}>{t('mailcowAccount.title')}</button>
      </nav>
      {tab === 'inbox' && <Inbox userId={props.userId} accountKey={props.accountKey} />}
      {tab === 'calendar' && <Calendar userId={props.userId} accountKey={props.accountKey} />}
      {tab === 'contacts' && <Contacts userId={props.userId} accountKey={props.accountKey} />}
    </div>
  )
}
