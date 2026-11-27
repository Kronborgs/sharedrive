import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'

const endpoint = '/api/v1/admin/settings/mailcow-test'
const protocols = [
  ['imap', 'IMAP'],
  ['smtp', 'SMTP'],
  ['caldav', 'CalDAV'],
  ['carddav', 'CardDAV'],
] as const
type ProbeSettings = { enabled: boolean; host: string }
const queryKey = ['admin', 'mailcow-test']

type ProbeResult = Record<(typeof protocols)[number][0], 'ok' | 'failed'>

export function MailcowTestPanel() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data, isError } = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.get<ProbeSettings>(endpoint, signal),
    retry: false,
  })
  const [hostPending, setHostPending] = useState(false)
  const [hostError, setHostError] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const [result, setResult] = useState<{ username: string; protocols: ProbeResult } | null>(null)

  async function saveHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (hostPending || pending) return
    const input = event.currentTarget.elements.namedItem('host') as HTMLInputElement
    setHostPending(true)
    setHostError(false)
    setError(false)
    setResult(null)
    try {
      const settings = await api.patch<ProbeSettings>(endpoint, { host: input.value })
      queryClient.setQueryData(queryKey, settings)
      input.value = settings.host
    } catch {
      setHostError(true)
    } finally {
      setHostPending(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || hostPending || !data?.host) return

    const form = event.currentTarget
    const values = new FormData(form)
    const username = values.get('username')
    const password = values.get('password')
    form.reset()
    if (typeof username !== 'string' || typeof password !== 'string') {
      setError(true)
      return
    }
    const account = username.trim()
    setPending(true)
    setError(false)
    setResult(null)
    try {
      const protocols = await api.post<ProbeResult>(endpoint, { username: account, password })
      setResult({ username: account, protocols })
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }

  if (isError) return <p role="alert" className="text-sm text-red-400">{t('mailcowTest.settingsUnavailable')}</p>
  if (!data) return null

  const inputClass = 'w-full rounded-lg border border-subtle bg-(--app-bg) px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
  return (
    <section aria-labelledby="mailcow-test-title" className="rounded-xl border border-subtle bg-surface p-4">
      <h2 id="mailcow-test-title" className="text-sm font-semibold">{t('mailcowTest.title')}</h2>
      <p className="my-2 text-sm text-muted">{t('mailcowTest.description')}</p>
      <form className="space-y-1" onSubmit={(event) => ignorePromise(saveHost(event))}>
        <label htmlFor="mailcow-test-host" className="text-sm">{t('mailcowTest.host')}</label>
        <div className="flex gap-2">
          <input id="mailcow-test-host" name="host" defaultValue={data.host} type="text" maxLength={253} placeholder="mail.example.com" autoComplete="off" spellCheck={false} className={inputClass} />
          <button type="submit" disabled={hostPending || pending} className="shrink-0 rounded-lg border border-subtle px-3 text-sm font-medium hover:bg-(--app-bg) disabled:opacity-60">
            {hostPending ? t('settings.saving') : t('mailcowTest.saveHost')}
          </button>
        </div>
        {hostError && <p role="alert" className="text-sm text-red-400">{t('mailcowTest.hostError')}</p>}
      </form>
      {!data.enabled && <p className="mt-3 text-sm text-muted">{t('mailcowTest.disabled')}</p>}
      {data.enabled && !data.host && <p className="mt-3 text-sm text-muted">{t('mailcowTest.setHostFirst')}</p>}
      {data.enabled && data.host && <form className="mt-4 space-y-3" onSubmit={(event) => ignorePromise(submit(event))}>
        <p className="break-all text-sm text-muted">{t('mailcowTest.target', { host: data.host })}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor="mailcow-test-username" className="text-sm">{t('login.email')}</label>
            <input id="mailcow-test-username" name="username" type="email" maxLength={254} required autoComplete="off" className={inputClass} />
          </div>
          <div className="space-y-1">
            <label htmlFor="mailcow-test-password" className="text-sm">{t('mailcowTest.appPassword')}</label>
            <input id="mailcow-test-password" name="password" type="password" maxLength={1024} required autoComplete="new-password" className={inputClass} />
          </div>
        </div>
        <button type="submit" disabled={pending || hostPending} className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
          {pending ? t('mailcowTest.running') : t('mailcowTest.run')}
        </button>
      </form>}
      <div aria-live="polite">
        {error && <p className="mt-3 text-sm text-red-400">{t('mailcowTest.unavailable')}</p>}
        {result && (
          <div className="mt-3 space-y-2 text-sm">
            <p className="break-all text-muted">{t('mailcowTest.result', { username: result.username })}</p>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {protocols.map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd className={result.protocols[key] === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
                    {t(result.protocols[key] === 'ok' ? 'mailcowTest.ok' : 'mailcowTest.failed')}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </section>
  )
}
