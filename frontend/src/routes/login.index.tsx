import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api, ApiClientError } from '@/lib/api'
import type { LoginResponse } from '@/types/api'
import { useAuth } from '@/lib/auth-context'
import { useI18n } from '@/lib/i18n'
import { greetingKey } from '@/lib/login-greeting'

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
  const { t } = useI18n()
  const [hour, setHour] = useState(() => new Date().getHours())
  useEffect(() => {
    const timer = window.setInterval(() => setHour(new Date().getHours()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const [showPassword, setShowPassword] = useState(false)
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
        const user = await api.get<{ rooms_only_account?: boolean }>('/api/v1/me')
        if (user.rooms_only_account) {
          const chats = await api.get<Array<{ slug: string }>>('/api/v1/rooms')
          if (chats.length === 1) await navigate({ to: '/rooms/$roomID', params: { roomID: chats[0].slug } })
          else await navigate({ to: '/rooms' })
        } else await navigate({ to: '/files' })
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message)
      } else {
        setError(t('login.unexpectedError'))
      }
    }
  }

  return (
    <>
      <h1 className="mb-6 text-2xl font-bold tracking-tight text-white sm:text-3xl">
        {t(greetingKey(hour))}
      </h1>

      <form
        onSubmit={handleSubmit(onSubmit)}
        className="space-y-4"
      >
        {error && (
          <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}

        <div className="space-y-1">
          <label htmlFor="login-email" className="block text-sm font-medium text-slate-200">
            {t('login.email')}
          </label>
          <input
            {...register('email')}
            id="login-email"
            type="email"
            autoComplete="email"
            className="min-h-11 w-full rounded-xl border border-subtle bg-(--app-bg)/80 px-3 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-400"
            placeholder={t('login.emailPlaceholder')}
          />
          {errors.email && (
            <p className="text-xs text-red-500">{errors.email.message}</p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="login-password" className="block text-sm font-medium text-slate-200">
            {t('login.password')}
          </label>
          <div className="relative">
            <input
              {...register('password')}
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              className="min-h-11 w-full rounded-xl border border-subtle bg-(--app-bg)/80 px-3 pr-11 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-400"
            />
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={t(showPassword ? 'login.hidePassword' : 'login.showPassword')}
              className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-xl text-slate-300 hover:text-white focus-visible:outline-2 focus-visible:outline-brand-400"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
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
            {t('login.trustDevice')}
          </label>
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="min-h-11 w-full rounded-xl bg-brand-600 font-semibold text-white transition-colors hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 disabled:opacity-60"
        >
          {isSubmitting ? t('login.signingIn') : t('login.sharedriveTitle')}
        </button>

        <div className="text-center">
          <a
            href="/reset-password"
            className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
          >
            {t('login.forgotPassword')}
          </a>
        </div>
      </form>
    </>
  )
}
