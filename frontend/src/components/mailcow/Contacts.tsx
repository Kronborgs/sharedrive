import { ContactRound, MailPlus, Plus, Search } from 'lucide-react'
import { useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'
import { cn } from '@/lib/utils'
import { control, DataStatus, fieldClass, formText, MailField, panel, primary, useMailData, useMailWrite, WriteStatus, type MailScope } from './shared'

type Contact = { id: string; name: string; email: string; phone: string }

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()
}

function ContactEditor({ onSaved, close }: Readonly<{ onSaved: () => void; close: () => void }>) {
  const { t } = useI18n()
  const write = useMailWrite(onSaved)
  return (
    <form className="space-y-3 p-5" onSubmit={event => write.submit(event, 'contact', data => ({
      name: formText(data, 'name'), email: formText(data, 'email'), phone: formText(data, 'phone'),
    }))}>
      <h2 className="text-lg font-semibold">{t('mailcowWorkspace.addContact')}</h2>
      <MailField name="name" label={t('mailcowWorkspace.name')} />
      <MailField name="email" type="email" required={false} label={t('login.email')} />
      <MailField name="phone" type="tel" required={false} label={t('mailcowWorkspace.phone')} />
      <div className="flex gap-2">
        <button type="submit" disabled={write.status === 'pending'} className={primary}>{t('mailcowWorkspace.addContact')}</button>
        <button type="button" className={control} onClick={close}>{t('action.close')}</button>
      </div>
      <WriteStatus status={write.status} />
    </form>
  )
}

export function MailContacts({ scope, compose }: Readonly<{ scope: MailScope; compose: (email: string) => void }>) {
  const { t, locale } = useI18n()
  const list = useMailData<Contact[]>(scope, 'contacts')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const filter = search.trim().toLocaleLowerCase(locale)
  const contacts = (list.data ?? [])
    .filter(item => [item.name, item.email, item.phone].some(value => value.toLocaleLowerCase(locale).includes(filter)))
    .sort((a, b) => a.name.localeCompare(b.name, locale))
  const current = contacts.find(item => item.id === selected)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className={cn(panel, 'flex flex-wrap gap-2 p-2.5')}>
        <div className="relative min-w-40 flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input type="search" value={search} onChange={event => setSearch(event.currentTarget.value)} className={cn(fieldClass, 'pl-9')}
            aria-label={t('mailcowWorkspace.searchContacts')} placeholder={t('mailcowWorkspace.searchContacts')} />
        </div>
        <button type="button" className={primary} onClick={() => setEditing(true)}><Plus size={16} />{t('mailcowWorkspace.addContact')}</button>
      </div>
      <div className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[minmax(14rem,0.9fr)_minmax(0,1.6fr)]">
        <section className={cn(panel, 'flex min-h-0 flex-col')}>
          <div className="flex justify-between gap-2 border-b border-subtle px-3 py-2.5">
            <h2 className="text-sm font-semibold">{t('mailcowWorkspace.addressBook')}</h2>
            <span className="rounded-full bg-brand-900/35 px-2 text-xs leading-5 text-brand-400">{contacts.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <DataStatus pending={list.isPending} error={list.isError} empty={list.isSuccess && contacts.length === 0} />
            {contacts.map(item => (
              <button type="button" key={item.id} aria-pressed={item.id === selected} onClick={() => { setSelected(item.id); setEditing(false) }}
                className={cn('flex w-full items-center gap-3 border-b border-subtle p-3 text-left hover:bg-(--app-bg)', item.id === selected && 'bg-brand-900/45')}>
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-700 text-xs font-semibold text-white">{initials(item.name) || '·'}</span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{item.name || item.email}</span>
                  <span className="block truncate text-xs text-muted">{item.email || item.phone}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
        <section className={cn(panel, 'min-h-32 overflow-auto')}>
          {editing && <ContactEditor close={() => setEditing(false)} onSaved={() => ignorePromise(list.refetch())} />}
          {!editing && current && <div className="space-y-4 p-5">
            <div className="flex items-center gap-3">
              <span className="grid size-12 shrink-0 place-items-center rounded-full bg-brand-700 font-semibold text-white">{initials(current.name) || '·'}</span>
              <h2 className="break-words text-xl font-semibold">{current.name || current.email}</h2>
            </div>
            <dl className="grid gap-4 rounded-xl border border-subtle p-4 sm:grid-cols-2">
              <div><dt className="text-xs text-muted">{t('login.email')}</dt><dd className="break-all text-sm">{current.email || '—'}</dd></div>
              <div><dt className="text-xs text-muted">{t('mailcowWorkspace.phone')}</dt><dd className="text-sm">{current.phone || '—'}</dd></div>
            </dl>
            {current.email && <button type="button" className={control} onClick={() => compose(current.email)}><MailPlus size={16} />{t('mailcowWorkspace.compose')}</button>}
          </div>}
          {!editing && !current && <div className="grid h-full place-items-center p-6 text-center text-sm text-muted">
            <div><ContactRound className="mx-auto mb-3" size={28} />{t('mailcowWorkspace.selectContact')}</div>
          </div>}
        </section>
      </div>
    </div>
  )
}
