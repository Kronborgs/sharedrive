import { useQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { api } from '@/lib/api'
import { ignorePromise } from '@/lib/ignore-promise'
import { useI18n } from '@/lib/i18n'
import { mailcowAccountEndpoint } from '@/lib/mailcow'

export const panel = 'min-h-0 min-w-0 overflow-hidden rounded-2xl border border-subtle bg-surface shadow-sm'
export const control = 'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-subtle px-3 py-2 text-sm hover:bg-(--app-bg) disabled:opacity-50'
export const primary = 'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50'
export const fieldClass = 'w-full rounded-lg border border-subtle bg-(--app-bg) px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
export type MailScope = Readonly<{ userId: string; accountKey: string }>
type QueryArguments = Record<string, string | number | null>

export function useMailData<T>(scope: MailScope, resource: string, args?: QueryArguments, enabled = true) {
  const url = mailcowAccountEndpoint + '/' + resource
  return useQuery({
    queryKey: ['mailcow-content', scope.userId, scope.accountKey, resource, args],
    queryFn: ({ signal }) => args ? api.post<T>(url, args) : api.get<T>(url, signal),
    enabled,
    retry: false,
  })
}

export function formText(data: FormData, name: string) {
  const value = data.get(name)
  return typeof value === 'string' ? value : ''
}

export function MailField({ name, label, type = 'text', required = true, defaultValue }: Readonly<{
  name: string; label: string; type?: string; required?: boolean; defaultValue?: string
}>) {
  return (
    <label className="block space-y-1 text-sm">
      <span>{label}</span>
      <input className={fieldClass} name={name} type={type} required={required} defaultValue={defaultValue} />
    </label>
  )
}

export function useMailWrite(onSaved?: () => void) {
  const [status, setStatus] = useState<'pending' | 'ok' | 'error' | null>(null)
  function submit(event: FormEvent<HTMLFormElement>, resource: string, values: (data: FormData) => Record<string, string>) {
    event.preventDefault()
    if (status === 'pending') return
    const form = event.currentTarget
    const data = new FormData(form)
    setStatus('pending')
    ignorePromise((async () => {
      try {
        await api.post(mailcowAccountEndpoint + '/' + resource, values(data))
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

export function WriteStatus({ status }: Readonly<{ status: ReturnType<typeof useMailWrite>['status'] }>) {
  const { t } = useI18n()
  if (status === 'error') return <p role="alert" className="text-sm text-red-400">{t('mailcowAccount.failed')}</p>
  return <output className="block text-sm text-emerald-400">{status === 'ok' ? t('mailcowWorkspace.done') : null}</output>
}

export function DataStatus({ pending, error, empty }: Readonly<{ pending: boolean; error: boolean; empty: boolean }>) {
  const { t } = useI18n()
  if (error) return <p role="alert" className="p-3 text-sm text-red-400">{t('mailcowAccount.failed')}</p>
  if (pending) return <p className="p-3 text-sm text-muted">{t('settings.loading')}</p>
  if (empty) return <p className="p-3 text-sm text-muted">{t('mailcowWorkspace.empty')}</p>
  return null
}
