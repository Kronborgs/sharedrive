import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { useForm, type UseFormRegister } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useState } from 'react'

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
})

type FormValues = z.infer<typeof settingsSchema>

type Tab = 'general' | 'smtp' | 'onlyoffice'

function GB(n: number) { return n / (1024 * 1024 * 1024) }
function toGB(g: number) { return Math.round(g * 1024 * 1024 * 1024) }
function MB(n: number) { return n / (1024 * 1024) }
function toMB(m: number) { return Math.round(m * 1024 * 1024) }

function SettingsPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('general')

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: ({ signal }) => api.get<SystemSettings>('/api/v1/admin/settings', signal),
  })

  const { register, handleSubmit, formState: { errors, isDirty } } = useForm<FormValues>({
    resolver: zodResolver(settingsSchema),
    values: data
      ? { ...data, default_quota_bytes: GB(data.default_quota_bytes), max_upload_bytes: MB(data.max_upload_bytes), direct_upload_url: data.direct_upload_url ?? '' }
      : undefined,
  })

  const [smtpPassword, setSmtpPassword] = useState('')
  const [testRecipient, setTestRecipient] = useState('')
  const [smtpResult, setSmtpResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const [ooURL, setOoURL] = useState('')
  const [ooSecret, setOoSecret] = useState('')
  const [ooSaving, setOoSaving] = useState(false)
  const [ooURLLoaded, setOoURLLoaded] = useState(false)

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
      toast.success('Indstillinger gemt')
      setSmtpPassword('')
      void qc.invalidateQueries({ queryKey: ['admin', 'settings'] })
      void qc.invalidateQueries({ queryKey: ['system', 'settings'] })
    },
    onError: () => toast.error('Kunne ikke gemme indstillinger'),
  })

  const testSMTP = useMutation({
    mutationFn: () => api.post('/api/v1/admin/settings/smtp-test', { to: testRecipient }),
    onSuccess: () => {
      setSmtpResult({ ok: true, msg: `Test-email sendt til ${testRecipient || 'din email'}` })
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : 'SMTP test fejlede'
      setSmtpResult({ ok: false, msg })
    },
  })

  const saveOnlyOffice = async () => {
    setOoSaving(true)
    try {
      const body: Record<string, string> = { onlyoffice_url: ooURL }
      if (ooSecret) body.onlyoffice_jwt_secret = ooSecret
      await api.patch('/api/v1/admin/settings', body)
      toast.success('OnlyOffice indstillinger gemt')
      setOoSecret('')
      void qc.invalidateQueries({ queryKey: ['admin', 'settings'] })
    } catch {
      toast.error('Kunne ikke gemme OnlyOffice indstillinger')
    } finally {
      setOoSaving(false)
    }
  }

  if (isLoading) {
    return <div className="p-8 text-center text-sm text-muted">Indlaeder...</div>
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'general', label: 'Generelt' },
    { id: 'smtp', label: 'SMTP' },
    { id: 'onlyoffice', label: 'OnlyOffice' },
  ]

  return (
    <div className="space-y-5 max-w-2xl">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">Systemindstillinger</h1>

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
            <Field label="Sitenavn" error={errors.site_name?.message}>
              <input {...register('site_name')} className={inputClass} />
            </Field>
            <Toggle label="Tillad offentlig registrering" description="Alle med URL kan oprette en konto." name="allow_registrations" register={register} />
            <Toggle label="Kraev invitation" description="Nye konti skal have et gyldigt invitationslink." name="require_invite" register={register} />
            <Field label="Standard kvote (GB)" error={errors.default_quota_bytes?.message}>
              <input type="number" step="0.5" min="0" {...register('default_quota_bytes')} className={inputClass} />
            </Field>
            <Field label="Maks uploadstorrelse (MB)" error={errors.max_upload_bytes?.message}>
              <input type="number" step="1" min="0" {...register('max_upload_bytes')} className={inputClass} />
            </Field>
            <Field label="Direkte upload-URL" error={errors.direct_upload_url?.message}>
              <input type="url" {...register('direct_upload_url')} placeholder="https://upload.ditdomaene.dk" className={inputClass} />
              <p className="text-[11px] text-zinc-400 dark:text-slate-500 mt-1">Valgfri URL der bypasser Cloudflare. Lad feltet staa tomt for normal rute.</p>
            </Field>
          </section>
          <div className="flex justify-end">
            <button type="submit" disabled={!isDirty || save.isPending} className="px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
              {save.isPending ? 'Gemmer...' : 'Gem aendringer'}
            </button>
          </div>
        </form>
      )}

      {tab === 'smtp' && (
        <form onSubmit={handleSubmit(values => save.mutate(values))} className="space-y-5">
          <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Host" error={errors.smtp_host?.message}>
                <input {...register('smtp_host')} placeholder="smtp.example.com" className={inputClass} />
              </Field>
              <Field label="Port" error={errors.smtp_port?.message}>
                <input type="number" {...register('smtp_port')} className={inputClass} />
              </Field>
            </div>
            <Field label="Brugernavn" error={errors.smtp_username?.message}>
              <input {...register('smtp_username')} className={inputClass} />
            </Field>
            <Field label="Adgangskode">
              <input type="password" value={smtpPassword} onChange={e => setSmtpPassword(e.target.value)} placeholder="Lad feltet staa tomt for at beholde eksisterende" autoComplete="new-password" className={inputClass} />
            </Field>
            <Field label="Afsenderadresse" error={errors.smtp_from_address?.message}>
              <input type="email" {...register('smtp_from_address')} placeholder="noreply@example.com" className={inputClass} />
            </Field>
            <Toggle label="Brug TLS/STARTTLS" description="Aktiver krypteret SMTP-forbindelse." name="smtp_tls" register={register} />
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <input type="email" value={testRecipient} onChange={e => { setTestRecipient(e.target.value); setSmtpResult(null) }} placeholder="Testmodtager (standard: din email)" className={`${inputClass} flex-1`} />
                <button type="button" onClick={() => { setSmtpResult(null); testSMTP.mutate() }} disabled={testSMTP.isPending} className="text-sm text-brand-600 dark:text-brand-400 hover:underline disabled:opacity-50 whitespace-nowrap">
                  {testSMTP.isPending ? 'Sender...' : 'Send test-email'}
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
              {save.isPending ? 'Gemmer...' : 'Gem aendringer'}
            </button>
          </div>
        </form>
      )}

      {tab === 'onlyoffice' && (
        <div className="space-y-5">
          <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-4">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">OnlyOffice Document Server</h2>
              <p className="text-xs text-muted">Tilslut en selvhostet OnlyOffice Document Server for at redigere og samarbejde om dokumenter direkte i Sharedrive. Hvis intet er konfigureret, vises filer som normalt.</p>
            </div>
            <Field label="Document Server URL">
              <input type="url" value={ooURL} onChange={e => setOoURL(e.target.value)} placeholder="https://onlyoffice.ditdomaene.dk" className={inputClass} />
              <p className="text-[11px] text-zinc-400 dark:text-slate-500 mt-1">URL til din OnlyOffice Document Server. Lad feltet staa tomt for at deaktivere.</p>
            </Field>
            <Field label="JWT Secret">
              <input type="password" value={ooSecret} onChange={e => setOoSecret(e.target.value)} placeholder="Lad feltet staa tomt for at beholde eksisterende secret" autoComplete="new-password" className={inputClass} />
              <p className="text-[11px] text-zinc-400 dark:text-slate-500 mt-1">Skal matche jwt.secret i din OnlyOffice-konfiguration. Anbefales staerkt.</p>
            </Field>
            {data?.onlyoffice_url ? (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/40">
                <span className="text-green-600 dark:text-green-400 text-xs font-medium">OnlyOffice er konfigureret</span>
                <span className="text-xs text-muted">{data.onlyoffice_url}</span>
              </div>
            ) : (
              <div className="p-3 rounded-lg bg-zinc-50 dark:bg-[#0f1117] border border-zinc-200 dark:border-[#2d3148]">
                <span className="text-xs text-muted">OnlyOffice er ikke konfigureret. Dokumenter abnes med standard preview.</span>
              </div>
            )}
          </section>
          <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-3">
            <h3 className="text-xs font-semibold text-zinc-700 dark:text-slate-300">Understoettede formater</h3>
            <div className="grid grid-cols-3 gap-3 text-xs text-muted">
              <div>
                <p className="font-medium text-zinc-600 dark:text-slate-400 mb-1">Tekstdokumenter</p>
                <p>DOC, DOCX, DOCM</p><p>DOT, DOTX, RTF</p><p>ODT, OTT, TXT</p>
              </div>
              <div>
                <p className="font-medium text-zinc-600 dark:text-slate-400 mb-1">Regneark</p>
                <p>XLS, XLSX, XLSM</p><p>XLSB, XLTX, CSV</p><p>ODS, OTS</p>
              </div>
              <div>
                <p className="font-medium text-zinc-600 dark:text-slate-400 mb-1">Praesentationer</p>
                <p>PPT, PPTX, PPTM</p><p>POTX, ODP, OTP</p>
              </div>
            </div>
          </section>
          <div className="flex justify-end">
            <button type="button" onClick={() => { void saveOnlyOffice() }} disabled={ooSaving} className="px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
              {ooSaving ? 'Gemmer...' : 'Gem OnlyOffice-indstillinger'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const inputClass =
  'w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500'

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
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
