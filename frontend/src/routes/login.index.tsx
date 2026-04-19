import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api, ApiClientError } from '@/lib/api'
import type { LoginResponse } from '@/types/api'
import { useAuth } from '@/lib/auth-context'

export const Route = createFileRoute('/login/')({
  component: LoginPage,
})

const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
  trust_device: z.boolean().optional(),
})
type FormValues = z.infer<typeof schema>

export default function LoginPage() {
  const navigate = useNavigate()
  const { refetch } = useAuth()
  const [error, setError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) })

  const onSubmit = async (values: FormValues) => {
    setError(null)
    try {
      const res = await api.post<LoginResponse>('/api/v1/auth/login', values)
      if (res.require_password_change) {
        // Token is delivered as an HttpOnly cookie; navigate without putting it in the URL.
        await navigate({ to: '/reset-password', search: { token: '', forced: '1' } })
      } else if (res.require_totp && res.pending_token) {
        await navigate({
          to: '/login/totp',
          search: { pending_token: res.pending_token, trust_device: values.trust_device ?? false },
        })
      } else {
        await refetch()
        await navigate({ to: '/files' })
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message)
      } else {
        setError('An unexpected error occurred. Please try again.')
      }
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-[#0f1117] px-4">
      <div className="w-full max-w-sm">
        {/* Logo / wordmark */}
        <div className="mb-8 text-center">
          <img src="/logo_name.png" alt="Sharedrive" className="h-10 w-auto mx-auto mb-2" />
          <p className="text-sm text-muted">Sign in to your account</p>
        </div>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-6 space-y-4 shadow-sm"
        >
          {error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="space-y-1">
            <label className="block text-sm font-medium text-zinc-700 dark:text-slate-300">
              Email
            </label>
            <input
              {...register('email')}
              type="email"
              autoComplete="email"
              className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-2 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
              placeholder="you@example.com"
            />
            {errors.email && (
              <p className="text-xs text-red-500">{errors.email.message}</p>
            )}
          </div>

          <div className="space-y-1">
            <label className="block text-sm font-medium text-zinc-700 dark:text-slate-300">
              Password
            </label>
            <input
              {...register('password')}
              type="password"
              autoComplete="current-password"
              className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-2 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
              placeholder="••••••••"
            />
            {errors.password && (
              <p className="text-xs text-red-500">{errors.password.message}</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              {...register('trust_device')}
              id="trust"
              type="checkbox"
              className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600 text-brand-600 focus:ring-brand-500"
            />
            <label htmlFor="trust" className="text-sm text-zinc-600 dark:text-slate-400">
              Trust this device for 30 days
            </label>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white font-medium py-2 text-sm transition-colors"
          >
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="text-center">
            <a
              href="/reset-password"
              className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
            >
              Forgot your password?
            </a>
          </div>
        </form>
      </div>
    </div>
  )
}
