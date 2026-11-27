import { CalendarDays, ChevronLeft, ChevronRight, List, Plus } from 'lucide-react'
import { useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'
import { cn } from '@/lib/utils'
import { control, DataStatus, formText, MailField, panel, primary, useMailData, useMailWrite, WriteStatus, type MailScope } from './shared'

type Appointment = { id: string; title: string; start: string; end: string; allDay: boolean }

function localDay(date: Date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}

function monthDays(month: Date) {
  const offset = (month.getDay() + 6) % 7
  return Array.from({ length: 42 }, (_, index) => new Date(month.getFullYear(), month.getMonth(), 1 - offset + index))
}

function groupAppointments(items: Appointment[], days: Date[]) {
  const byDay = new Map<string, Appointment[]>()
  for (const item of items) {
    const start = item.allDay ? item.start : localDay(new Date(item.start))
    const end = item.allDay ? item.end : localDay(new Date(Math.max(Date.parse(item.end) - 1, Date.parse(item.start))))
    for (const day of days) {
      const key = localDay(day)
      const overlaps = key >= start && (item.allDay ? key < end : key <= end)
      if (!overlaps) continue
      const entries = byDay.get(key) ?? []
      entries.push(item)
      byDay.set(key, entries)
    }
  }
  return byDay
}

function AppointmentForm({ day, onSaved, onClose }: Readonly<{ day: string; onSaved: () => void; onClose: () => void }>) {
  const { t } = useI18n()
  const write = useMailWrite(onSaved)
  return (
    <form className="space-y-3 border-b border-subtle p-4" onSubmit={event => write.submit(event, 'event', data => ({
      title: formText(data, 'title'), start: new Date(formText(data, 'start')).toISOString(), end: new Date(formText(data, 'end')).toISOString(),
    }))}>
      <h3 className="font-semibold">{t('mailcowWorkspace.addEvent')}</h3>
      <MailField name="title" label={t('mailcowWorkspace.eventTitle')} />
      <MailField name="start" type="datetime-local" defaultValue={day + 'T09:00'} label={t('mailcowWorkspace.start')} />
      <MailField name="end" type="datetime-local" defaultValue={day + 'T10:00'} label={t('mailcowWorkspace.end')} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={write.status === 'pending'} className={primary}>{t('mailcowWorkspace.addEvent')}</button>
        <button type="button" className={control} onClick={onClose}>{t('action.close')}</button>
      </div>
      <WriteStatus status={write.status} />
    </form>
  )
}

function eventTime(event: Appointment, locale: string) {
  return event.allDay ? '' : new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(event.start))
}

function AppointmentList({ day, items }: Readonly<{ day: string; items: Appointment[] }>) {
  const { t, locale } = useI18n()
  return (
    <section className="p-4">
      <h3 className="mb-3 text-sm font-semibold">
        {new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(new Date(day + 'T12:00:00'))}
      </h3>
      <DataStatus pending={false} error={false} empty={items.length === 0} />
      <ul className="space-y-2">
        {items.map(item => <li key={item.id + item.start} className="rounded-lg border border-subtle bg-(--app-bg)/50 p-3 text-sm">
          <p className="break-words font-medium">{item.title || t('mailcowWorkspace.noSubject')}</p>
          <p className="text-xs text-muted">{eventTime(item, locale)}</p>
        </li>)}
      </ul>
    </section>
  )
}

export function MailCalendar({ scope, username }: Readonly<{ scope: MailScope; username: string }>) {
  const { t, locale } = useI18n()
  const today = new Date()
  const todayKey = localDay(today)
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const [selected, setSelected] = useState(todayKey)
  const [agenda, setAgenda] = useState(false)
  const [editing, setEditing] = useState(false)
  const days = monthDays(month)
  const end = new Date(days[41].getFullYear(), days[41].getMonth(), days[41].getDate() + 1)
  const list = useMailData<Appointment[]>(scope, 'calendar', { start: days[0].toISOString(), end: end.toISOString() })
  const entries = groupAppointments(list.data ?? [], days)
  const monthLabel = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(month)

  function changeMonth(next: Date) {
    setMonth(new Date(next.getFullYear(), next.getMonth(), 1))
    setSelected(localDay(next))
    setEditing(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className={cn(panel, 'flex flex-wrap items-center gap-2 p-2.5')}>
        <button type="button" className={control} onClick={() => changeMonth(today)}>{t('mailcowWorkspace.today')}</button>
        <button type="button" className={control} aria-label={t('mailcowWorkspace.previousMonth')} onClick={() => changeMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={16} /></button>
        <button type="button" className={control} aria-label={t('mailcowWorkspace.nextMonth')} onClick={() => changeMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={16} /></button>
        <h2 className="mr-auto font-semibold capitalize">{monthLabel}</h2>
        <button type="button" className={control} aria-pressed={agenda} onClick={() => setAgenda(value => !value)}>
          {agenda ? <CalendarDays size={16} /> : <List size={16} />}{t(agenda ? 'mailcowWorkspace.month' : 'mailcowWorkspace.agenda')}
        </button>
        <button type="button" className={primary} onClick={() => setEditing(true)}><Plus size={16} />{t('mailcowWorkspace.addEvent')}</button>
      </div>
      <div className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[minmax(0,1fr)_16rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
        <section className={cn(panel, 'overflow-auto')}>
          <DataStatus pending={list.isPending} error={list.isError} empty={false} />
          {agenda ? (
            <div>
              {days.filter(day => entries.has(localDay(day))).map(day => {
                const key = localDay(day)
                return <AppointmentList key={key} day={key} items={entries.get(key) ?? []} />
              })}
              <DataStatus pending={false} error={false} empty={list.isSuccess && entries.size === 0} />
            </div>
          ) : (
            <div className="grid min-h-full grid-cols-7 grid-rows-[auto_repeat(6,minmax(4rem,1fr))] bg-(--app-bg)/35">
              {days.slice(0, 7).map(day => (
                <div key={localDay(day)} className="border-b border-subtle p-1.5 text-center text-[10px] font-semibold uppercase text-muted sm:text-xs">
                  {new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(day)}
                </div>
              ))}
              {days.map(day => {
                const key = localDay(day)
                return (
                  <button type="button" key={key} aria-pressed={selected === key}
                    aria-label={new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(day)}
                    className={cn('flex min-h-16 min-w-0 flex-col items-start overflow-hidden border-b border-r border-subtle p-1 text-left hover:bg-brand-900/25 sm:p-2',
                      day.getMonth() !== month.getMonth() && 'text-muted', selected === key && 'bg-brand-900/30')}
                    onClick={() => { setSelected(key); setEditing(false) }}>
                    <span className={cn('mb-1 inline-grid size-6 place-items-center rounded-full text-xs', key === todayKey && 'bg-brand-600 text-white')}>
                      {day.getDate()}
                    </span>
                    {(entries.get(key) ?? []).slice(0, 3).map(event => <span key={event.id + event.start}
                      className="mb-1 block w-full truncate rounded bg-brand-900/50 px-1 text-[10px] text-brand-400 sm:text-xs"
                      title={event.title}>{eventTime(event, locale)} {event.title}</span>)}
                    {(entries.get(key)?.length ?? 0) > 3 && <span className="text-[10px] text-muted">+{(entries.get(key)?.length ?? 0) - 3}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </section>
        <aside className={cn(panel, 'overflow-auto')}>
          <div className="border-b border-subtle p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t('mailcowWorkspace.primaryCalendar')}</p>
            <p className="mt-1 break-all text-sm">{username}</p>
          </div>
          {editing && <AppointmentForm key={selected} day={selected} onSaved={() => ignorePromise(list.refetch())} onClose={() => setEditing(false)} />}
          <AppointmentList day={selected} items={entries.get(selected) ?? []} />
        </aside>
      </div>
    </div>
  )
}
