import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { useForm, type UseFormRegister } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useState } from 'react'
import { ONLYOFFICE_GROUPS, TEXT_EDITOR_GROUPS } from '@/lib/file-types'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'

export const Route = createFileRoute('/_auth/admin/settings/')({
  component: SettingsPage,
})

interface SystemSettings {
  site_name: string
  allow_registrations: boolean
  require_invite: boolean
  default_quota_bytes: number
  max_upload_bytes: number
  direct_upload_url: string
  smtp_host: string
  smtp_port: number
  smtp_username: string
  smtp_from_address: string
  smtp_tls: boolean
  onlyoffice_url: string
  onlyoffice_jwt_secret: string
  playlist_max_tracks: number
}

const settingsSchema = z.object({
  site_name: z.string().min(1),
  allow_registrations: z.boolean(),
  require_invite: z.boolean(),
  default_quota_bytes: z.coerce.number().min(0),
  max_upload_bytes: z.coerce.number().min(0),
  direct_upload_url: z.string().url().or(z.literal('')),
  smtp_host: z.string(),
  smtp_port: z.coerce.number().min(1).max(65535),
  smtp_username: z.string(),
  smtp_from_address: z.string().email().or(z.literal('')),
  smtp_tls: z.boolean(),
  playlist_max_tracks: z.coerce.number().min(1).max(10000),
})

type FormValues = z.infer<typeof settingsSchema>

type Tab = 'general' | 'smtp' | 'onlyoffice' | 'texteditor' | 'player'
type SMTPProviderId = 'gmail' | 'microsoft365' | 'outlook' | 'yahoo' | 'zoho' | 'custom'

const SMTP_PROVIDER_PRESETS: Record<Exclude<SMTPProviderId, 'custom'>, { host: string; port: number; tls: boolean }> = {
  gmail: { host: 'smtp.gmail.com', port: 587, tls: true },
  microsoft365: { host: 'smtp.office365.com', port: 587, tls: true },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, tls: true },
  yahoo: { host: 'smtp.mail.yahoo.com', port: 587, tls: true },
  zoho: { host: 'smtp.zoho.com', port: 587, tls: true },
}

function resolveSMTPProvider(host: string, port: number, tls: boolean): SMTPProviderId {
  const normalizedHost = (host ?? '').trim().toLowerCase()
  for (const [provider, preset] of Object.entries(SMTP_PROVIDER_PRESETS) as Array<[Exclude<SMTPProviderId, 'custom'>, { host: string; port: number; tls: boolean }]>) {
    if (normalizedHost === preset.host && port === preset.port && tls === preset.tls) {
      return provider
    }
  }
  return 'custom'
}

function GB(n: number) { return n / (1024 * 1024 * 1024) }
function toGB(g: number) { return Math.round(g * 1024 * 1024 * 1024) }
function MB(n: number) { return n / (1024 * 1024) }
function toMB(m: number) { return Math.round(m * 1024 * 1024) }

function SettingsPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('general')
  const { t } = useI18n()

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: ({ signal }) => api.get<SystemSettings>('/api/v1/admin/settings', signal),
  })

  const { register, handleSubmit, watch, setValue, formState: { errors, isDirty } } = useForm<FormValues>({
    resolver: zodResolver(settingsSchema),
    values: data
      ? { ...data, default_quota_bytes: GB(data.default_quota_bytes), max_upload_bytes: MB(data.max_upload_bytes), direct_upload_url: data.direct_upload_url ?? '', playlist_max_tracks: data.playlist_max_tracks ?? 200 }
      : undefined,
  })

  const [smtpPassword, setSmtpPassword] = useState('')
  const [testRecipient, setTestRecipient] = useState('')
  const [smtpResult, setSmtpResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const [ooURL, setOoURL] = useState('')
  const [ooSecret, setOoSecret] = useState('')
  const [ooSaving, setOoSaving] = useState(false)
  const [ooURLLoaded, setOoURLLoaded] = useState(false)
  const [ooTestResult, setOoTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const testOO = useMutation({
    mutationFn: () => api.get<{ ok: boolean; error?: string; status?: number }>('/api/v1/onlyoffice/test'),
    onSuccess: (d) => setOoTestResult({ ok: d.ok, msg: d.ok ? t('settings.connectionOk') : (d.error ?? `HTTP ${d.status}`) }),
    onError: () => setOoTestResult({ ok: false, msg: t('settings.testFailed') }),
  })

  if (data && !ooURLLoaded) {
    setOoURL(data.onlyoffice_url ?? '')
    setOoURLLoaded(true)
  }

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      const body: Record<string, unknown> = {
        ...values,
        default_quota_bytes: toGB(values.default_quota_bytes),
        max_upload_bytes: toMB(values.max_upload_bytes),
        direct_upload_url: values.direct_upload_url,
      }
      if (smtpPassword) body.smtp_password = smtpPassword
      return api.patch('/api/v1/admin/settings', body)
    },
    onSuccess: () => {
      toast.success(t('settings.saved'))
      setSmtpPassword('')
      ignorePromise(qc.invalidateQueries({ queryKey: ['admin', 'settings'] }))
      ignorePromise(qc.invalidateQueries({ queryKey: ['system', 'settings'] }))
    },
    onError: () => toast.error(t('settings.saveFailed')),
  })

  const testSMTP = useMutation({
    mutationFn: () => api.post('/api/v1/admin/settings/smtp-test', { to: testRecipient }),
    onSuccess: () => {
      setSmtpResult({ ok: true, msg: t('settings.testEmailSentTo', { to: testRecipient || 'din email' }) })
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : t('settings.smtpTestFailed')
      setSmtpResult({ ok: false, msg })
    },
  })

  const saveOnlyOffice = async () => {
    setOoSaving(true)
    try {
      const body: Record<string, string> = { onlyoffice_url: ooURL }
      if (ooSecret) body.onlyoffice_jwt_secret = ooSecret
      await api.patch('/api/v1/admin/settings', body)
      toast.success(t('settings.ooSaved'))
      setOoSecret('')
      ignorePromise(qc.invalidateQueries({ queryKey: ['admin', 'settings'] }))
    } catch {
      toast.error(t('settings.ooSaveFailed'))
    } finally {
      setOoSaving(false)
    }
  }

  if (isLoading) {
    return <div className="p-8 text-center text-sm text-muted">{t('settings.loading')}</div>
  }

  const smtpHost = watch('smtp_host')
  const smtpPort = watch('smtp_port')
  const smtpTls = watch('smtp_tls')
  const selectedSMTPProvider = resolveSMTPProvider(smtpHost, smtpPort, smtpTls)

  const onSMTPProviderChange = (provider: SMTPProviderId) => {
    if (provider === 'custom') return
    const preset = SMTP_PROVIDER_PRESETS[provider]
    setValue('smtp_host', preset.host, { shouldDirty: true })
    setValue('smtp_port', preset.port, { shouldDirty: true })
    setValue('smtp_tls', preset.tls, { shouldDirty: true })
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'general',    label: t('settings.tabGeneral') },
    { id: 'smtp',       label: t('settings.tabSmtp') },
    { id: 'onlyoffice', label: t('settings.tabOnlyOffice') },
    { id: 'texteditor', label: t('settings.tabTextEditor') },
    { id: 'player',     label: t('settings.tabPlayer') },
  ]

  return (
    <div className="space-y-5 max-w-2xl">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">{t('settings.title')}</h1>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-zinc-200 dark:border-[#2d3148]">
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={[
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === t.id
                ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                : 'border-transparent text-zinc-500 dark:text-slate-400 hover:text-zinc-900 dark:hover:text-slate-100',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <form onSubmit={handleSubmit(values => save.mutate(values))} className="space-y-5">
          <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-4">
            <Field label={t('settings.siteName')} error={errors.site_name?.message}>
              <input {...register('site_name')} className={inputClass} />
            </Field>
            <Toggle label={t('settings.allowReg')} description={t('settings.allowRegDesc')} name="allow_registrations" register={register} />
            <Toggle label={t('settings.requireInvite')} description={t('settings.requireInviteDesc')} name="require_invite" register={register} />
            <Field label={t('settings.defaultQuota')} error={errors.default_quota_bytes?.message}>
              <input type="number" step="0.5" min="0" {...register('default_quota_bytes')} className={inputClass} />
            </Field>
            <Field label={t('settings.maxUpload')} error={errors.max_upload_bytes?.message}>
              <input type="number" step="1" min="0" {...register('max_upload_bytes')} className={inputClass} />
            </Field>
            <Field label={t('settings.directUploadUrl')} error={errors.direct_upload_url?.message}>
              <input type="url" {...register('direct_upload_url')} placeholder={t('settings.directUploadUrlPlaceholder')} className={inputClass} />
              <p className="text-[11px] text-zinc-400 dark:text-slate-500 mt-1">{t('settings.directUploadUrlDesc')}</p>
            </Field>
          </section>
          <div className="flex justify-end">
            <button type="submit" disabled={!isDirty || save.isPending} className="px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
              {save.isPending ? t('settings.saving') : t('settings.saveChanges')}
            </button>
          </div>
        </form>
      )}

      {tab === 'smtp' && (
        <form onSubmit={handleSubmit(values => save.mutate(values))} className="space-y-5">
          <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-4">
            <Field label={t('settings.smtpProvider')}>
              <select
                value={selectedSMTPProvider}
                onChange={e => onSMTPProviderChange(e.target.value as SMTPProviderId)}
                className={inputClass}
              >
                <option value="gmail">{t('settings.smtpProviderGmail')}</option>
                <option value="microsoft365">{t('settings.smtpProviderMicrosoft365')}</option>
                <option value="outlook">{t('settings.smtpProviderOutlook')}</option>
                <option value="yahoo">{t('settings.smtpProviderYahoo')}</option>
                <option value="zoho">{t('settings.smtpProviderZoho')}</option>
                <option value="custom">{t('settings.smtpProviderCustom')}</option>
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('settings.smtpHost')} error={errors.smtp_host?.message}>
                <input {...register('smtp_host')} placeholder="smtp.example.com" className={inputClass} />
              </Field>
              <Field label={t('settings.smtpPort')} error={errors.smtp_port?.message}>
                <input type="number" {...register('smtp_port')} className={inputClass} />
              </Field>
            </div>
            <Field label={t('settings.username')} error={errors.smtp_username?.message}>
              <input {...register('smtp_username')} className={inputClass} />
            </Field>
            <Field label={t('settings.smtpPassword')}>
              <input type="password" value={smtpPassword} onChange={e => setSmtpPassword(e.target.value)} placeholder={t('settings.smtpPasswordPlaceholder')} autoComplete="new-password" className={inputClass} />
            </Field>
            <Field label={t('settings.fromAddress')} error={errors.smtp_from_address?.message}>
              <input type="email" {...register('smtp_from_address')} placeholder="noreply@example.com" className={inputClass} />
            </Field>
            <Toggle label={t('settings.useTls')} description={t('settings.useTlsDesc')} name="smtp_tls" register={register} />
            {selectedSMTPProvider !== 'custom' && (
              <p className="text-xs text-zinc-500 dark:text-slate-400">
                {t('settings.smtpPresetHint', {
                  host: SMTP_PROVIDER_PRESETS[selectedSMTPProvider].host,
                  port: SMTP_PROVIDER_PRESETS[selectedSMTPProvider].port,
                  mode: SMTP_PROVIDER_PRESETS[selectedSMTPProvider].tls ? 'STARTTLS' : 'None',
                })}
              </p>
            )}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <input type="email" value={testRecipient} onChange={e => { setTestRecipient(e.target.value); setSmtpResult(null) }} placeholder={t('settings.testRecipientPlaceholder')} className={`${inputClass} flex-1`} />
                <button type="button" onClick={() => { setSmtpResult(null); testSMTP.mutate() }} disabled={testSMTP.isPending} className="text-sm text-brand-600 dark:text-brand-400 hover:underline disabled:opacity-50 whitespace-nowrap">
                  {testSMTP.isPending ? t('settings.sending') : t('settings.sendTestEmail')}
                </button>
              </div>
              {smtpResult && (
                <p className={`text-xs px-1 ${smtpResult.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  {smtpResult.ok ? 'v' : 'x'} {smtpResult.msg}
                </p>
              )}
            </div>
          </section>
          <div className="flex justify-end">
            <button type="submit" disabled={(!isDirty && !smtpPassword) || save.isPending} className="px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
              {save.isPending ? t('settings.saving') : t('settings.saveChanges')}
            </button>
          </div>
        </form>
      )}

      {tab === 'onlyoffice' && (
        <div className="space-y-5">
          <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-4">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">OnlyOffice Document Server</h2>
              <p className="text-xs text-muted">{t('settings.ooDesc')}</p>
            </div>
            <Field label={t('settings.ooUrlLabel')}>
              <input type="url" value={ooURL} onChange={e => setOoURL(e.target.value)} placeholder="https://onlyoffice.ditdomaene.dk" className={inputClass} />
              <p className="text-[11px] text-zinc-400 dark:text-slate-500 mt-1">{t('settings.ooUrlDesc')}</p>
            </Field>
            <Field label={t('settings.ooSecretLabel')}>
              <input type="password" value={ooSecret} onChange={e => setOoSecret(e.target.value)} placeholder={t('settings.ooSecretPlaceholder')} autoComplete="new-password" className={inputClass} />
              <p className="text-[11px] text-zinc-400 dark:text-slate-500 mt-1">{t('settings.ooSecretDesc')}</p>
            </Field>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => { setOoTestResult(null); testOO.mutate() }}
                  disabled={testOO.isPending || !ooURL}
                  className="text-sm text-brand-600 dark:text-brand-400 hover:underline disabled:opacity-50 whitespace-nowrap"
                >
                  {testOO.isPending ? t('settings.testing') : t('settings.testConnection')}
                </button>
                {!ooURL && <span className="text-xs text-muted">{t('settings.saveUrlFirst')}</span>}
              </div>
              {ooTestResult && (
                <p className={`text-xs px-1 ${ooTestResult.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  {ooTestResult.ok ? '✓' : '✗'} {ooTestResult.msg}
                </p>
              )}
            </div>
          </section>
          <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-semibold text-zinc-700 dark:text-slate-300">{t('settings.supportedFormats')}</h3>
            <div>
              {ONLYOFFICE_GROUPS.map(group => (
                <div key={group.label}>
                  <p className="font-medium text-zinc-600 dark:text-slate-400 mb-1">{group.label}</p>
                  {chunkArray([...group.exts], 3).map(row => (
                    <p key={`${group.label}-${row.join('-')}`}>{row.map(e => e.toUpperCase()).join(', ')}</p>
                  ))}
                </div>
              ))}
            </div>
          </section>
          <div className="flex justify-end">
            <button type="button" onClick={() => { ignorePromise(saveOnlyOffice()) }} disabled={ooSaving} className="px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
              {ooSaving ? t('settings.saving') : t('settings.saveOo')}
            </button>
          </div>
        </div>
      )}

      {tab === 'texteditor' && (
        <div className="space-y-5">
          <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-4">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">Text Editor</h2>
              <p className="text-xs text-muted">{t('settings.textEditorDesc')}</p>
            </div>
          </section>
          <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-semibold text-zinc-700 dark:text-slate-300">{t('settings.supportedFormats')}</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs text-muted">
              {TEXT_EDITOR_GROUPS.map(group => (
                <div key={group.label}>
                  <p className="font-medium text-zinc-600 dark:text-slate-400 mb-1">{group.label}</p>
                  {[...group.exts].map(ext => (
                    <p key={ext}>*.{ext}</p>
                  ))}
                </div>
              ))}
            </div>
          </section>
          <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-2">
            <h3 className="text-xs font-semibold text-zinc-700 dark:text-slate-300">{t('settings.textEditorFeatures')}</h3>
            <ul className="text-xs text-muted space-y-1 list-disc list-inside">
              <li>{t('settings.teFeature1')}</li>
              <li>{t('settings.teFeature2')}</li>
              <li>{t('settings.teFeature3')}</li>
              <li>{t('settings.teFeature4')}</li>
              <li>{t('settings.teFeature5')}</li>
              <li>{t('settings.teFeature6')}</li>
              <li>{t('settings.teFeature7')}</li>
              <li>{t('settings.teFeature8')}</li>
            </ul>
          </section>
        </div>
      )}

      {tab === 'player' && (
        <form onSubmit={handleSubmit(values => save.mutate(values))} className="space-y-5">
          <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-4">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">{t('settings.playerTitle')}</h2>
              <p className="text-xs text-muted">{t('settings.playerDesc')}</p>
            </div>
            <Field label={t('settings.maxPlaylistTracks')} error={errors.playlist_max_tracks?.message}>
              <input type="number" step="1" min="1" max="10000" {...register('playlist_max_tracks')} className={inputClass} />
              <p className="text-[11px] text-zinc-400 dark:text-slate-500 mt-1">{t('settings.maxPlaylistTracksDesc')}</p>
            </Field>
          </section>
          <div className="flex justify-end">
            <button type="submit" disabled={!isDirty || save.isPending} className="px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
              {save.isPending ? t('settings.saving') : t('settings.saveChanges')}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

const inputClass =
  'w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500'

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size))
  return result
}

function Field({ label, error, children }: Readonly<{ label: string; error?: string; children: React.ReactNode }>) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{label}</label>
      {children}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}

function Toggle({
  label, description, name, register,
}: {
  label: string; description: string; name: string; register: UseFormRegister<FormValues>
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input type="checkbox" {...register(name as Parameters<typeof register>[0])} className="mt-0.5 rounded border-zinc-300 dark:border-[#4d5678] text-brand-600 focus:ring-brand-500 focus:ring-offset-0" />
      <div>
        <p className="text-sm text-zinc-900 dark:text-slate-100">{label}</p>
        <p className="text-xs text-muted">{description}</p>
      </div>
    </label>
  )
}
