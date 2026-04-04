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
  smtp_host: string
  smtp_port: number
  smtp_username: string
  smtp_from_address: string
  smtp_tls: boolean
}

const settingsSchema = z.object({
  site_name: z.string().min(1),
  allow_registrations: z.boolean(),
  require_invite: z.boolean(),
  default_quota_bytes: z.coerce.number().min(0),
  max_upload_bytes: z.coerce.number().min(0),
  smtp_host: z.string(),
  smtp_port: z.coerce.number().min(1).max(65535),
  smtp_username: z.string(),
  smtp_from_address: z.string().email().or(z.literal('')),
  smtp_tls: z.boolean(),
})

type FormValues = z.infer<typeof settingsSchema>

function GB(n: number) { return n / (1024 * 1024 * 1024) }
function toGB(g: number) { return Math.round(g * 1024 * 1024 * 1024) }
function MB(n: number) { return n / (1024 * 1024) }
function toMB(m: number) { return Math.round(m * 1024 * 1024) }

function SettingsPage() {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: ({ signal }) => api.get<SystemSettings>('/api/v1/admin/settings', signal),
  })

  const { register, handleSubmit, formState: { errors, isDirty } } = useForm<FormValues>({
    resolver: zodResolver(settingsSchema),
    values: data
      ? { ...data, default_quota_bytes: GB(data.default_quota_bytes), max_upload_bytes: MB(data.max_upload_bytes) }
      : undefined,
  })

  const [smtpPassword, setSmtpPassword] = useState('')
  const [testRecipient, setTestRecipient] = useState('')
  const [smtpResult, setSmtpResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      const body: Record<string, unknown> = {
        ...values,
        default_quota_bytes: toGB(values.default_quota_bytes),
        max_upload_bytes: toMB(values.max_upload_bytes),
      }
      if (smtpPassword) body.smtp_password = smtpPassword
      return api.patch('/api/v1/admin/settings', body)
    },
    onSuccess: () => {
      toast.success('Settings saved')
      setSmtpPassword('')
      void qc.invalidateQueries({ queryKey: ['admin', 'settings'] })
    },
    onError: () => toast.error('Failed to save settings'),
  })

  const testSMTP = useMutation({
    mutationFn: () => api.post('/api/v1/admin/settings/smtp-test', { to: testRecipient }),
    onSuccess: () => {
      setSmtpResult({ ok: true, msg: `Test email sent to ${testRecipient || 'your account email'}` })
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : 'SMTP test failed'
      setSmtpResult({ ok: false, msg })
    },
  })

  if (isLoading) {
    return <div className="p-8 text-center text-sm text-muted">Loading…</div>
  }

  return (
    <form
      onSubmit={handleSubmit(values => save.mutate(values))}
      className="space-y-6 max-w-2xl"
    >
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">System Settings</h1>

      {/* General */}
      <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-4">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">General</h2>

        <Field label="Site name" error={errors.site_name?.message}>
          <input {...register('site_name')} className={inputClass} />
        </Field>

        <Toggle label="Allow public registrations" description="Anyone with the URL can create an account." name="allow_registrations" register={register} />
        <Toggle label="Require invitation" description="New accounts must have a valid invitation link to register." name="require_invite" register={register} />

        <Field label="Default user quota (GB)" error={errors.default_quota_bytes?.message}>
          <input type="number" step="0.5" min="0" {...register('default_quota_bytes')} className={inputClass} />
        </Field>

        <Field label="Max upload size (MB)" error={errors.max_upload_bytes?.message}>
          <input type="number" step="1" min="0" {...register('max_upload_bytes')} className={inputClass} />
        </Field>
      </section>

      {/* SMTP */}
      <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4 space-y-4">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">SMTP (Email)</h2>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Host" error={errors.smtp_host?.message}>
            <input {...register('smtp_host')} placeholder="smtp.example.com" className={inputClass} />
          </Field>
          <Field label="Port" error={errors.smtp_port?.message}>
            <input type="number" {...register('smtp_port')} className={inputClass} />
          </Field>
        </div>

        <Field label="Username" error={errors.smtp_username?.message}>
          <input {...register('smtp_username')} className={inputClass} />
        </Field>

        <Field label="Password">
          <input
            type="password"
            value={smtpPassword}
            onChange={e => setSmtpPassword(e.target.value)}
            placeholder="Leave blank to keep existing password"
            autoComplete="new-password"
            className={inputClass}
          />
        </Field>

        <Field label="From address" error={errors.smtp_from_address?.message}>
          <input type="email" {...register('smtp_from_address')} placeholder="noreply@example.com" className={inputClass} />
        </Field>

        <Toggle label="Use TLS/STARTTLS" description="Enable encrypted SMTP connection." name="smtp_tls" register={register} />

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="email"
              value={testRecipient}
              onChange={e => { setTestRecipient(e.target.value); setSmtpResult(null) }}
              placeholder="Test recipient (defaults to your email)"
              className={`${inputClass} flex-1`}
            />
            <button
              type="button"
              onClick={() => { setSmtpResult(null); testSMTP.mutate() }}
              disabled={testSMTP.isPending}
              className="text-sm text-brand-600 dark:text-brand-400 hover:underline disabled:opacity-50 whitespace-nowrap"
            >
              {testSMTP.isPending ? 'Sending…' : 'Send test email'}
            </button>
          </div>
          {smtpResult && (
            <p className={`text-xs px-1 ${smtpResult.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {smtpResult.ok ? '✓' : '✗'} {smtpResult.msg}
            </p>
          )}
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={(!isDirty && !smtpPassword) || save.isPending}
          className="px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
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
  label,
  description,
  name,
  register,
}: {
  label: string
  description: string
  name: string
  register: UseFormRegister<FormValues>
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
