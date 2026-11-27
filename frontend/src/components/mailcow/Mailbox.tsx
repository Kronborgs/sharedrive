import { ArrowLeft, ChevronLeft, ChevronRight, Folder, Inbox, MailPlus, Paperclip, RefreshCw, Reply, Search } from 'lucide-react'
import { useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'
import { cn } from '@/lib/utils'
import { control, DataStatus, fieldClass, formText, MailField, panel, primary, useMailData, useMailWrite, WriteStatus, type MailScope } from './shared'

type FolderKind = 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive' | 'junk' | 'custom'
type MailFolder = { path: string; name: string; specialUse: FolderKind; unread: number }
type Message = { uid: number; subject: string; from: string; fromName: string; date: string; seen: boolean; hasAttachments: boolean }
type MessageDetail = Message & { text: string }
type Draft = { to: string; subject: string; textBody?: string }
const defaultFolder: MailFolder = { path: 'INBOX', name: 'INBOX', specialUse: 'inbox', unread: 0 }

function MailComposer({ draft, close }: Readonly<{ draft: Draft; close: () => void }>) {
  const { t } = useI18n()
  const write = useMailWrite()
  return (
    <form className="space-y-3 p-4 sm:p-5" onSubmit={event => write.submit(event, 'send', data => ({
      to: formText(data, 'to'), subject: formText(data, 'subject'), body: formText(data, 'body'),
    }))}>
      <h2 className="text-lg font-semibold">{t('mailcowWorkspace.compose')}</h2>
      <MailField name="to" label={t('mailcowWorkspace.to')} type="email" defaultValue={draft.to} />
      <MailField name="subject" label={t('mailcowWorkspace.subject')} defaultValue={draft.subject} />
      <label className="block space-y-1 text-sm">
        <span>{t('mailcowWorkspace.body')}</span>
        <textarea name="body" rows={9} maxLength={24_000} defaultValue={draft.textBody} required className={fieldClass} />
      </label>
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={write.status === 'pending'}>{t('mailcowWorkspace.send')}</button>
        <button type="button" className={control} onClick={close}>{t('action.close')}</button>
      </div>
      <WriteStatus status={write.status} />
    </form>
  )
}

function displayDate(value: string, locale: string, full = false) {
  if (!Number.isFinite(Date.parse(value))) return ''
  return new Intl.DateTimeFormat(locale, full ? { dateStyle: 'medium', timeStyle: 'short' } : { day: 'numeric', month: 'short' }).format(new Date(value))
}

function ReadingPane({ scope, folder, uid, close, reply }: Readonly<{
  scope: MailScope; folder: string; uid: number | null; close: () => void; reply: (draft: Draft) => void
}>) {
  const { t, locale } = useI18n()
  const message = useMailData<MessageDetail>(scope, 'message', { folder, uid }, uid !== null)
  const item = message.data
  if (uid === null) return <div className="grid h-full place-items-center p-6 text-center text-sm text-muted"><div><Inbox className="mx-auto mb-3" size={28} />{t('mailcowWorkspace.selectMessage')}</div></div>
  return (
    <div className="h-full overflow-auto p-4 sm:p-5">
      <button type="button" className={cn(control, 'mb-3 lg:hidden')} onClick={close}><ArrowLeft size={15} />{t('mailcowWorkspace.messages')}</button>
      <DataStatus pending={message.isPending} error={message.isError} empty={false} />
      {item && <>
        {item.from && <button type="button" className={cn(control, 'mb-4')} onClick={() => reply({
          to: item.from, subject: /^re:/i.test(item.subject) ? item.subject : 'Re: ' + item.subject,
        })}><Reply size={16} />{t('mailcowWorkspace.reply')}</button>}
        <h2 className="break-words text-xl font-semibold">{item.subject || t('mailcowWorkspace.noSubject')}</h2>
        <p className="my-3 break-all text-sm text-muted">{item.fromName && item.fromName !== item.from ? item.fromName + ' · ' : ''}{item.from} · {displayDate(item.date, locale, true)}</p>
        <div className="whitespace-pre-wrap break-words rounded-xl border border-subtle bg-(--app-bg)/70 p-4 text-sm leading-relaxed">
          {item.text || t('mailcowWorkspace.noText')}
        </div>
      </>}
    </div>
  )
}

export function Mailbox({ scope, recipient, initialDraft }: Readonly<{ scope: MailScope; recipient?: string; initialDraft?: Omit<Draft, 'to'> }>) {
  const { t, locale } = useI18n()
  const folders = useMailData<MailFolder[]>(scope, 'folders')
  const [folder, setFolder] = useState('INBOX')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [uid, setUid] = useState<number | null>(null)
  const recipientDraft = recipient ? { to: recipient, subject: '' } : null
  const [draft, setDraft] = useState<Draft | null>(initialDraft ? { to: '', ...initialDraft } : recipientDraft)
  const list = useMailData<{ messages: Message[]; total: number }>(scope, 'folder', { folder, page, search })
  const allFolders = folders.data?.length ? folders.data : [defaultFolder]
  const folderName = (value: MailFolder) => value.specialUse === 'custom' ? value.name : t(`mailcowFolder.${value.specialUse}`)
  const currentFolder = allFolders.find(value => value.path === folder) ?? defaultFolder
  const showReading = uid !== null || draft !== null
  const canPageForward = page * 20 < (list.data?.total ?? 0)

  function selectFolder(path: string) {
    setFolder(path)
    setPage(1)
    setUid(null)
  }

  return (
    <div className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[9.75rem_minmax(13rem,0.85fr)_minmax(0,1.5fr)] xl:grid-cols-[12rem_minmax(16rem,0.9fr)_minmax(0,1.65fr)]">
      <aside aria-label={t('mailcowWorkspace.folders')} className={cn(panel, 'hidden overflow-auto p-3 lg:block')}>
        <button type="button" className={cn(primary, 'mb-4 w-full')} onClick={() => setDraft({ to: '', subject: '' })}><MailPlus size={16} />{t('mailcowWorkspace.compose')}</button>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t('mailcowWorkspace.folders')}</p>
        {allFolders.map(item => (
          <button
            key={item.path} type="button" aria-pressed={folder === item.path} onClick={() => selectFolder(item.path)}
            className={cn('mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-(--app-bg)', folder === item.path && 'bg-brand-900/45 text-brand-400')}
          >
            <Folder size={15} className="shrink-0" /><span className="flex-1 truncate">{folderName(item)}</span>
            {item.unread > 0 && <span className="rounded-full bg-brand-900/35 px-1.5 text-xs">{item.unread}</span>}
          </button>
        ))}
        {folders.isError && <DataStatus pending={false} error empty={false} />}
      </aside>
      <section className={cn(panel, 'flex min-h-0 flex-col', showReading && 'hidden lg:flex')}>
        <div className="space-y-2 border-b border-subtle p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{folderName(currentFolder)}</h2>
            <div className="flex gap-1">
              <button type="button" className={cn(control, 'lg:hidden')} onClick={() => setDraft({ to: '', subject: '' })}><MailPlus size={15} />{t('mailcowWorkspace.compose')}</button>
              <button type="button" className={control} aria-label={t('mailcowWorkspace.refresh')} onClick={() => { ignorePromise(list.refetch()); ignorePromise(folders.refetch()) }}><RefreshCw size={15} /></button>
            </div>
          </div>
          <select className={cn(fieldClass, 'lg:hidden')} aria-label={t('mailcowWorkspace.folders')} value={folder} onChange={event => selectFolder(event.currentTarget.value)}>
            {allFolders.map(item => <option value={item.path} key={item.path}>{folderName(item)}</option>)}
          </select>
          <form className="flex gap-1" onSubmit={event => {
            event.preventDefault()
            setSearch(formText(new FormData(event.currentTarget), 'search').trim())
            setPage(1)
            setUid(null)
          }}>
            <input name="search" type="search" maxLength={240} className={fieldClass} aria-label={t('mailcowWorkspace.searchMail')} placeholder={t('mailcowWorkspace.searchMail')} />
            <button type="submit" className={control} aria-label={t('mailcowWorkspace.searchMail')}><Search size={15} /></button>
          </form>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <DataStatus pending={list.isPending} error={list.isError} empty={list.data?.messages.length === 0} />
          {list.data?.messages.map(item => (
            <button key={item.uid} type="button" aria-pressed={uid === item.uid} onClick={() => { setUid(item.uid); setDraft(null) }}
              className={cn('block w-full border-b border-subtle px-3 py-2.5 text-left text-sm hover:bg-(--app-bg)', uid === item.uid && 'bg-brand-900/45')}>
              <span className="flex items-center gap-2">
                {!item.seen && <span className="size-2 shrink-0 rounded-full bg-brand-400" />}
                <span className={cn('min-w-0 flex-1 truncate', !item.seen && 'font-semibold')}>{item.fromName || item.from}</span>
                {item.hasAttachments && <Paperclip className="shrink-0 text-muted" size={12} />}
                <span className="text-xs text-muted">{displayDate(item.date, locale)}</span>
              </span>
              <span className="block truncate">{item.subject || t('mailcowWorkspace.noSubject')}</span>
            </button>
          ))}
        </div>
        {(page > 1 || canPageForward) && <div className="flex items-center justify-between gap-2 border-t border-subtle p-2 text-xs text-muted">
          <button type="button" className={control} disabled={page === 1} aria-label={t('mailcowWorkspace.previous')} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} /></button>
          <span>{page}</span>
          <button type="button" className={control} disabled={!canPageForward} aria-label={t('mailcowWorkspace.next')} onClick={() => setPage(value => value + 1)}><ChevronRight size={16} /></button>
        </div>}
      </section>
      <section className={cn(panel, draft && 'overflow-auto', !showReading && 'hidden lg:block')}>
        {draft ? <MailComposer key={draft.to + draft.subject} draft={draft} close={() => setDraft(null)} /> :
          <ReadingPane scope={scope} folder={folder} uid={uid} close={() => setUid(null)} reply={setDraft} />}
      </section>
    </div>
  )
}
