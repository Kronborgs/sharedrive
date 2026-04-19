import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/lib/api'
import { useState } from 'react'
import { toast } from 'sonner'

const searchSchema = z.object({
  token: z.string().catch(''),
  forced: z.string().catch(''), // set when redirected from forced-reset login flow
})

const schema = z
  .object({
    password: z.string().min(12, 'At least 12 characters'),
    confirm: z.string(),
  })
  .refine(d => d.password === d.confirm, { message: 'Passwords do not match', path: ['confirm'] })

type FormValues = z.infer<typeof schema>

export const Route = createFileRoute('/reset-password/')({
  validateSearch: searchSchema,
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const navigate = useNavigate()
  const { token, forced } = Route.useSearch()
  const [requestEmail, setRequestEmail] = useState('')
  const [requestSent, setRequestSent] = useState(false)
  const [requestLoading, setRequestLoading] = useState(false)

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema),
  })

  // No token = show request form, UNLESS this is a forced-reset flow (cookie carries the token)
  if (!token && !forced) {
    const handleRequest = async (e: React.FormEvent) => {
      e.preventDefault()
      if (!requestEmail) return
      setRequestLoading(true)
      try {
        await api.post('/api/v1/auth/password-reset/request', { email: requestEmail })
        setRequestSent(true)
      } catch {
        toast.error('Request failed. Please try again.')
      } finally {
        setRequestLoading(false)
      }
    }

    return (
      <AuthShell>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100 mb-1">Reset password</h1>
        <p className="text-sm text-muted mb-5">Enter your email to receive a reset link.</p>

        {requestSent ? (
          <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 text-sm text-emerald-700 dark:text-emerald-400">
            If that email is registered, you'll receive a reset link shortly.
          </div>
        ) : (
          <form onSubmit={handleRequest} className="space-y-4">
            <input
              type="email"
              value={requestEmail}
              onChange={e => setRequestEmail(e.target.value)}
              placeholder="you@example.com"
              className={inputClass}
              required
            />
            <button type="submit" disabled={requestLoading} className={btnClass}>
              {requestLoading ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}
        <p className="text-xs text-center text-muted mt-4">
          <a href="/login" className="text-brand-600 dark:text-brand-400 hover:underline">Back to login</a>
        </p>
      </AuthShell>
    )
  }

  // With token = show new password form
  const onSubmit = async (values: FormValues) => {
    try {
      await api.post('/api/v1/auth/password-reset/confirm', {
        token,
        new_password: values.password,
      })
      toast.success('Password updated! Redirecting to login…')
      setTimeout(() => void navigate({ to: '/login' }), 1500)
    } catch {
      toast.error('Reset link is invalid or expired.')
    }
  }

  return (
    <AuthShell>
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100 mb-1">Choose a new password</h1>
      <p className="text-sm text-muted mb-5">Must be at least 12 characters.</p>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1">
          <input type="password" {...register('password')} placeholder="New password" className={inputClass} />
          {errors.password && <p className="text-xs text-red-500">{errors.password.message}</p>}
        </div>
        <div className="space-y-1">
          <input type="password" {...register('confirm')} placeholder="Confirm password" className={inputClass} />
          {errors.confirm && <p className="text-xs text-red-500">{errors.confirm.message}</p>}
        </div>
        <button type="submit" disabled={isSubmitting} className={btnClass}>
          {isSubmitting ? 'Saving…' : 'Set new password'}
        </button>
      </form>
    </AuthShell>
  )
}

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-[#0f1117] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <img src="/logo_name.png" alt="Sharedrive" className="h-8 w-auto mx-auto" />
        </div>
        <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-2xl p-6 shadow-sm">
          {children}
        </div>
      </div>
    </div>
  )
}

const inputClass =
  'w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-2 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500'
const btnClass =
  'w-full px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors'
