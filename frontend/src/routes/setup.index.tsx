import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { Check, CheckCircle2, ChevronRight, Mail, Upload, XCircle } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'

export const Route = createFileRoute('/setup/')({
  component: SetupPage,
})

// ─── Step schemas ───────────────────────────────────────────────

const step1Schema = z.object({
  site_name: z.string().min(1, 'Required'),
})

const step2Schema = z
  .object({
    display_name: z.string().min(2, 'At least 2 characters'),
    email: z.string().email('Invalid email'),
    password: z.string().min(12, 'At least 12 characters'),
    confirm: z.string(),
  })
  .refine(d => d.password === d.confirm, { message: 'Passwords do not match', path: ['confirm'] })

const step3Schema = z.object({
  smtp_host: z.string(),
  smtp_port: z.coerce.number().min(1).max(65535),
  smtp_username: z.string(),
  smtp_password: z.string(),
  smtp_from_address: z.string().email('Invalid email').or(z.literal('')),
  smtp_tls: z.boolean(),
  skip: z.boolean(),
})

type Step1Values = z.infer<typeof step1Schema>
type Step2Values = z.infer<typeof step2Schema>
type Step3Values = z.infer<typeof step3Schema>

const STEPS = ['Site', 'Admin account', 'Email (optional)'] as const

// ─── Page ────────────────────────────────────────────────────────

function SetupPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [s1, setS1] = useState<Step1Values | null>(null)
  const [s2, setS2] = useState<Step2Values | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreFile, setRestoreFile] = useState<File | null>(null)

  const handleRestore = async () => {
    if (!restoreFile) return
    setRestoring(true)
    try {
      const formData = new FormData()
      formData.append('backup', restoreFile)
      const r = await fetch('/api/v1/system/onboarding/restore', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
      if (!r.ok) {
        const data = await r.json() as { error?: string }
        throw new Error(data.error ?? 'Restore failed')
      }
      toast.success(t('setup.restoreComplete'))
      setTimeout(() => ignorePromise(navigate({ to: '/login' })), 1200)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('setup.restoreFailed'))
    } finally {
      setRestoring(false)
    }
  }

  const submit = async (s3: Step3Values) => {
    if (!s1 || !s2) return
    setSubmitting(true)
    try {
      await api.post('/api/v1/setup', {
        site_name: s1.site_name,
        admin_display_name: s2.display_name,
        admin_email: s2.email,
        admin_password: s2.password,
        smtp: s3.skip ? null : {
          host: s3.smtp_host,
          port: s3.smtp_port,
          username: s3.smtp_username,
          password: s3.smtp_password,
          from_address: s3.smtp_from_address,
          tls: s3.smtp_tls,
        },
      })
      toast.success(t('setup.setupComplete'))
      setTimeout(() => ignorePromise(navigate({ to: '/login' })), 1200)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('setup.setupFailed')
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-[#0f1117] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <img src="/logo_name.png" alt="Sharedrive" className="h-10 w-auto mx-auto mb-2" />
          <p className="text-sm text-muted mt-1">{t('setup.firstTimeSetup')}</p>
        </div>

        {/* Steps indicator */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {STEPS.map((_label, i) => (
            <div key={_label} className="flex items-center gap-2">
              <StepIndicator index={i} currentStep={step} />
              <StepGlyph index={i} currentStep={step} />
              {i < STEPS.length - 1 && <ChevronRight size={12} className="text-zinc-300 dark:text-slate-600" />}
            </div>
          ))}
        </div>

        <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-2xl p-6 shadow-sm">
          {step === 0 && (
            <Step1
              onNext={v => { setS1(v); setStep(1) }}
              restoreFile={restoreFile}
              onRestoreFileChange={setRestoreFile}
              onRestore={handleRestore}
              restoring={restoring}
            />
          )}
          {step === 1 && <Step2 onBack={() => setStep(0)} onNext={v => { setS2(v); setStep(2) }} />}
          {step === 2 && <Step3 onBack={() => setStep(1)} onNext={submit} submitting={submitting} />}
        </div>
      </div>
    </div>
  )
}

function StepIndicator({ index, currentStep }: Readonly<{ index: number; currentStep: number }>) {
  let className = 'w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors '
  if (index < currentStep) {
    className += 'bg-brand-600 text-white'
  } else if (index === currentStep) {
    className += 'bg-brand-100 dark:bg-brand-900/40 text-brand-600 dark:text-brand-400 ring-2 ring-brand-400'
  } else {
    className += 'bg-zinc-200 dark:bg-[#2d3148] text-zinc-400'
  }

  return <div className={className} />
}

function StepGlyph({ index, currentStep }: Readonly<{ index: number; currentStep: number }>) {
  if (index < currentStep) {
    return <Check size={12} />
  }
  return <>{index + 1}</>
}

// ─── Step 1: Site name ───────────────────────────────────────────

function Step1({
  onNext,
  restoreFile,
  onRestoreFileChange,
  onRestore,
  restoring,
}: Readonly<{
  onNext: (v: Step1Values) => void
  restoreFile: File | null
  onRestoreFileChange: (f: File | null) => void
  onRestore: () => void
  restoring: boolean
}>) {
  const { register, handleSubmit, formState: { errors } } = useForm<Step1Values>({
    resolver: zodResolver(step1Schema),
    defaultValues: { site_name: 'Sharedrive' },
  })
  const { t } = useI18n()
  return (
    <div className="space-y-5">
      <form onSubmit={handleSubmit(onNext)} className="space-y-4">
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100 mb-1">{t('setup.siteConfigTitle')}</h2>
          <p className="text-sm text-muted">{t('setup.siteConfigDesc')}</p>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('setup.siteName')}</label>
          <input {...register('site_name')} className={inputClass} placeholder={t('setup.sitePlaceholder')} />
          {errors.site_name && <p className="text-xs text-red-500">{errors.site_name.message}</p>}
        </div>
        <button type="submit" className={btnClass}>{t('setup.continue')}</button>
      </form>

      {/* Restore from backup */}
      <div className="border-t border-zinc-100 dark:border-[#2d3148] pt-4 space-y-3">
        <p className="text-xs text-muted text-center">{t('setup.orRestore')}</p>
        <label className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors w-full">
          <Upload size={14} className="shrink-0 text-zinc-400" />
          <span className="truncate text-zinc-600 dark:text-slate-400">
            {restoreFile ? restoreFile.name : t('setup.chooseBackupFile')}
          </span>
          <input
            type="file"
            accept=".gz,.json.gz"
            className="sr-only"
            onChange={e => onRestoreFileChange(e.target.files?.[0] ?? null)}
          />
        </label>
        {restoreFile && (
          <button
            onClick={onRestore}
            disabled={restoring}
            className="flex items-center justify-center gap-2 w-full px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {restoring ? t('setup.restoring') : t('setup.restoreFromBackup')}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Step 2: Admin account ──────────────────────────────────────

function Step2({ onBack, onNext }: Readonly<{ onBack: () => void; onNext: (v: Step2Values) => void }>) {
  const { t } = useI18n()
  const { register, handleSubmit, formState: { errors } } = useForm<Step2Values>({
    resolver: zodResolver(step2Schema),
  })
  return (
    <form onSubmit={handleSubmit(onNext)} className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100 mb-1">{t('setup.adminAccountTitle')}</h2>
        <p className="text-sm text-muted">{t('setup.adminAccountDesc')}</p>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('setup.displayName')}</label>
        <input {...register('display_name')} className={inputClass} placeholder={t('setup.displayNamePlh')} />
        {errors.display_name && <p className="text-xs text-red-500">{errors.display_name.message}</p>}
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('setup.email')}</label>
        <input type="email" {...register('email')} className={inputClass} placeholder="admin@example.com" />
        {errors.email && <p className="text-xs text-red-500">{errors.email.message}</p>}
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('setup.password')}</label>
        <input type="password" {...register('password')} className={inputClass} />
        {errors.password && <p className="text-xs text-red-500">{errors.password.message}</p>}
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('setup.confirmPassword')}</label>
        <input type="password" {...register('confirm')} className={inputClass} />
        {errors.confirm && <p className="text-xs text-red-500">{errors.confirm.message}</p>}
      </div>
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onBack} className={backBtnClass}>{t('setup.back')}</button>
        <button type="submit" className={btnClass + ' flex-1'}>{t('setup.continue')}</button>
      </div>
    </form>
  )
}

// ─── Step 3: SMTP ────────────────────────────────────────────────

function Step3({
  onBack,
  onNext,
  submitting,
}: Readonly<{
  onBack: () => void
  onNext: (v: Step3Values) => void
  submitting: boolean
}>) {
  const { t } = useI18n()
  const { register, handleSubmit, watch, getValues } = useForm<Step3Values>({
    defaultValues: { smtp_port: 587, smtp_tls: true, skip: false },
  })
  const skip = watch('skip')
  const [testing, setTesting] = useState(false)
  const [testTo, setTestTo] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const handleTestEmail = async () => {
    const v = getValues()
    if (!v.smtp_host || !v.smtp_from_address) {
      setTestResult({ ok: false, msg: t('setup.testFillHost') })
      return
    }
    if (!testTo) {
      setTestResult({ ok: false, msg: t('setup.testEnterRecipient') })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      await api.post('/api/v1/system/onboarding/smtp-test', {
        host: v.smtp_host,
        port: v.smtp_port,
        username: v.smtp_username,
        password: v.smtp_password,
        from_address: v.smtp_from_address,
        to_address: testTo,
        tls: v.smtp_tls,
      })
      setTestResult({ ok: true, msg: t('setup.testEmailSent', { to: testTo }) })
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : t('setup.testFailed')
      // Surface the most useful part of common SMTP errors
      let msg = raw
      if (raw.includes('535') || raw.includes('534') || raw.includes('InvalidSecondFactor') || raw.includes('password')) {
        msg = t('setup.testAuthFailed')
      } else if (raw.includes('connection refused') || raw.includes('dial')) {
        msg = t('setup.testConnFailed')
      } else if (raw.includes('certificate') || raw.includes('tls')) {
        msg = t('setup.testTlsError')
      }
      setTestResult({ ok: false, msg })
    } finally {
      setTesting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit(onNext)} className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100 mb-1">{t('setup.smtpTitle')}</h2>
        <p className="text-sm text-muted">{t('setup.smtpDesc')}</p>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" {...register('skip')} className="rounded border-zinc-300 text-brand-600" />
        <span className="text-sm text-zinc-700 dark:text-slate-300">{t('setup.skipForNow')}</span>
      </label>

      {!skip && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('setup.smtpHost')}</label>
              <input {...register('smtp_host')} className={inputClass} placeholder="smtp.example.com" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('setup.smtpPort')}</label>
              <input type="number" {...register('smtp_port')} className={inputClass} />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('setup.smtpUsername')}</label>
            <input {...register('smtp_username')} className={inputClass} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('setup.password')}</label>
            <input type="password" {...register('smtp_password')} className={inputClass} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('setup.smtpFromAddress')}</label>
            <input type="email" {...register('smtp_from_address')} className={inputClass} placeholder="noreply@example.com" />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" {...register('smtp_tls')} className="rounded border-zinc-300 text-brand-600" />
            <span className="text-sm text-zinc-700 dark:text-slate-300">{t('setup.useTls')}</span>
          </label>

          {/* Test email */}
          <div className="border-t border-zinc-100 dark:border-[#2d3148] pt-3 space-y-2">
            <p className="text-xs text-muted">{t('setup.testEmailDesc')}</p>
            <div className="flex gap-2">
              <input
                type="email"
                value={testTo}
                onChange={e => { setTestTo(e.target.value); setTestResult(null) }}
                className={inputClass}
                placeholder="your@email.com"
              />
              <button
                type="button"
                onClick={handleTestEmail}
                disabled={testing}
                className="flex items-center gap-1.5 shrink-0 px-3 py-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] disabled:opacity-50 transition-colors"
              >
                <Mail size={13} />
                {testing ? t('setup.sending') : t('setup.test')}
              </button>
            </div>
            {testResult && (
              <div className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                testResult.ok
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
              }`}>
                {testResult.ok
                  ? <CheckCircle2 size={13} className="shrink-0 mt-0.5" />
                  : <XCircle size={13} className="shrink-0 mt-0.5" />}
                <span>{testResult.msg}</span>
              </div>
            )}
          </div>
        </>
      )}

      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onBack} className={backBtnClass}>{t('setup.back')}</button>
        <button type="submit" disabled={submitting} className={btnClass + ' flex-1'}>
          {submitting ? t('setup.settingUp') : t('setup.completeSetup')}
        </button>
      </div>
    </form>
  )
}

const inputClass =
  'w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-2 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500'
const btnClass =
  'px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors w-full'
const backBtnClass =
  'px-4 py-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors'
