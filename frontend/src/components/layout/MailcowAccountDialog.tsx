import * as Dialog from '@radix-ui/react-dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'
import { MailcowWorkspace } from './MailcowWorkspace'

const endpoint = '/api/v1/me/mailcow'
const protocols = ['imap', 'smtp', 'caldav', 'carddav'] as const
type Account = { host: string; username: string }
type AccountState = { enabled: boolean; ready: boolean; account: Account | null }
type ProbeResult = Record<(typeof protocols)[number], 'ok' | 'failed'>

export function MailcowAccountDialog({ userId, close }: Readonly<{ userId: string; close: () => void }>) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const queryKey = ['mailcow-account', userId]
  const { data, isError, isPending } = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.get<AccountState>(endpoint, signal),
    retry: false,
  })
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'intro' | 'details' | 'workspace' | 'settings'>('intro')
  const [failed, setFailed] = useState(false)
  const [result, setResult] = useState<ProbeResult | null>(null)

  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setFailed(false)
    setResult(null)
    try {
      await action()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !data?.enabled || !data.ready) return
    const form = event.currentTarget
    const fields = new FormData(form)
    const passwordInput = form.elements.namedItem('password') as HTMLInputElement
    passwordInput.value = ''
    ignorePromise(run(async () => {
      const { account, protocols } = await api.put<{ account: Account | null; protocols: ProbeResult }>(endpoint, {
        host: fields.get('host'), username: fields.get('username'), password: fields.get('password'),
      })
      setResult(protocols)
      if (account) {
        queryClient.setQueryData<AccountState>(queryKey, { enabled: true, ready: true, account })
        await queryClient.invalidateQueries({ queryKey: ['mailcow-content', userId] })
        setView('workspace')
      }
    }))
  }

  const workspace = Boolean(data?.enabled && data.ready && data.account && view !== 'settings')
  const details = data?.enabled && data.ready && (view === 'details' || view === 'settings')
  const inputClass = 'w-full rounded-lg border border-subtle bg-(--app-bg) px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
  const buttonClass = 'rounded-lg border border-subtle px-3 py-2 text-sm hover:bg-(--app-bg) disabled:opacity-50'

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/65" />
        <Dialog.Content className="fixed inset-x-4 top-1/2 z-[101] mx-auto max-h-[calc(100dvh-2rem)] max-w-3xl -translate-y-1/2 overflow-auto rounded-2xl border border-subtle bg-surface p-5 shadow-xl">
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title className="text-lg font-semibold">{t(workspace ? 'mailcowModule.title' : 'mailcowModule.setupTitle')}</Dialog.Title>
            <Dialog.Close className="rounded p-1 text-muted hover:text-white" aria-label={t('action.close')}><X size={18} /></Dialog.Close>
          </div>
          <Dialog.Description className="mt-1 text-sm text-muted">{t('mailcowAccount.description')}</Dialog.Description>
          {isPending && <p className="mt-3 text-sm text-muted">{t('settings.loading')}</p>}
          {isError && <p role="alert" className="mt-3 text-sm text-red-400">{t('mailcowTest.settingsUnavailable')}</p>}
          {data && (!data.enabled || !data.ready) && <p className="mt-3 text-sm text-muted">{t('mailcowAccount.disabled')}</p>}
          {workspace && data?.account && (
            <MailcowWorkspace userId={userId} accountKey={data.account.host + '/' + data.account.username} settings={() => setView('settings')} />
          )}
          {data?.enabled && data.ready && !data.account && view === 'intro' && (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-muted">{t('mailcowModule.setupHint')}</p>
              <button type="button" className={buttonClass} onClick={() => setView('details')}>{t('mailcowModule.setupContinue')}</button>
            </div>
          )}
          {details && data?.account && (
            <p className="mt-3 break-all text-sm text-muted">
              {t('mailcowAccount.connected', { username: data.account.username, host: data.account.host })}
            </p>
          )}
          {details && (
            <form key={JSON.stringify(data.account)} onSubmit={save} className="mt-4 space-y-3">
              <label className="block space-y-1 text-sm">
                <span>{t('mailcowTest.host')}</span>
                <input name="host" type="text" required maxLength={253} placeholder="mail.example.com" defaultValue={data?.account?.host} autoComplete="off" spellCheck={false} className={inputClass} />
              </label>
              <label className="block space-y-1 text-sm">
                <span>{t('login.email')}</span>
                <input name="username" type="email" required maxLength={254} defaultValue={data?.account?.username} autoComplete="off" className={inputClass} />
              </label>
              <label className="block space-y-1 text-sm">
                <span>{t('mailcowTest.appPassword')}</span>
                <input name="password" type="password" required maxLength={1024} autoComplete="new-password" className={inputClass} />
              </label>
              <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
                {t('mailcowModule.connect')}
              </button>
            </form>
          )}
          {view === 'settings' && data?.account && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className={buttonClass} onClick={() => setView('workspace')}>{t('mailcowWorkspace.back')}</button>
              {data.ready && <button type="button" disabled={busy} className={buttonClass} onClick={() => ignorePromise(run(async () => {
                setResult(await api.post<ProbeResult>(endpoint + '/test', {}))
              }))}>{t('mailcowTest.run')}</button>}
              <button type="button" disabled={busy} className={buttonClass} onClick={() => ignorePromise(run(async () => {
                await api.delete(endpoint)
                queryClient.setQueryData<AccountState>(queryKey, { enabled: data.enabled, ready: data.ready, account: null })
                queryClient.removeQueries({ queryKey: ['mailcow-content', userId] })
                setView('intro')
              }))}>{t('mailcowAccount.disconnect')}</button>
            </div>
          )}
          <div aria-live="polite">
            {busy && <p className="mt-3 text-sm text-muted">{t('mailcowAccount.working')}</p>}
            {failed && <p className="mt-3 text-sm text-red-400">{t('mailcowAccount.failed')}</p>}
            {result && !workspace && <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              {protocols.map((protocol) => <div key={protocol}>
                <dt>{protocol.toUpperCase()}</dt>
                <dd className={result[protocol] === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
                  {t(result[protocol] === 'ok' ? 'mailcowTest.ok' : 'mailcowTest.failed')}
                </dd>
              </div>)}
            </dl>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
