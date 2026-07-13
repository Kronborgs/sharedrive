import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/lib/api'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'

const searchSchema = z.object({
  token: z.string().catch(''),
})

const schema = z
  .object({
    display_name: z.string().min(2, 'At least 2 characters'),
    password: z.string().min(12, 'At least 12 characters'),
    confirm: z.string(),
  })
  .refine(d => d.password === d.confirm, {
    message: 'Passwords do not match',
    path: ['confirm'],
  })

type FormValues = z.infer<typeof schema>

interface InviteInfo {
  email: string
  inviter_name: string
  expires_at: string
}

export const Route = createFileRoute('/accept-invite/')({
  validateSearch: searchSchema,
  component: AcceptInvitePage,
})

function AcceptInvitePage() {
  const navigate = useNavigate()
  const { token } = Route.useSearch()
  const { t } = useI18n()

  const { data: invite, isLoading, isError } = useQuery({
    queryKey: ['invite', token],
    queryFn: ({ signal }) => api.get<InviteInfo>(`/api/v1/invitations/${token}`, signal),
    enabled: !!token,
    retry: false,
  })

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema),
  })

  const onSubmit = async (values: FormValues) => {
    try {
      await api.post(`/api/v1/invitations/${token}/accept`, {
        display_name: values.display_name,
        password: values.password,
      })
      toast.success(t('invite.accountCreated'))
      setTimeout(() => ignorePromise(navigate({ to: '/login' })), 1200)
    } catch {
      toast.error(t('invite.invalidLink'))
    }
  }

  if (!token) {
    return (
      <Shell>
        <p className="text-sm text-red-500">Missing invitation token.</p>
      </Shell>
    )
  }

  if (isLoading) {
    return (
      <Shell>
        <p className="text-sm text-muted text-center">{t('invite.verifying')}</p>
      </Shell>
    )
  }

  if (isError || !invite) {
    return (
      <Shell>
        <p className="text-sm text-red-500 text-center">
          {t('invite.invalidExpired')}
        </p>
        <a href="/login" className="block text-center text-xs text-brand-600 dark:text-brand-400 hover:underline mt-3">
          {t('invite.backToLogin')}
        </a>
      </Shell>
    )
  }

  return (
    <Shell>
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100 mb-1">{t('invite.createAccount')}</h1>
      <p className="text-sm text-muted mb-5">
        {t('invite.invitedBy')} <strong>{invite.inviter_name}</strong>. {t('invite.yourEmailWillBe')}{' '}
        <strong>{invite.email}</strong>.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-1">
          <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('invite.displayName')}</label>
          <input {...register('display_name')} className={inputClass} placeholder={t('invite.yourName')} />
          {errors.display_name && <p className="text-xs text-red-500">{errors.display_name.message}</p>}
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('login.password')}</label>
          <input type="password" {...register('password')} className={inputClass} />
          {errors.password && <p className="text-xs text-red-500">{errors.password.message}</p>}
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('reset.confirmPassword')}</label>
          <input type="password" {...register('confirm')} className={inputClass} />
          {errors.confirm && <p className="text-xs text-red-500">{errors.confirm.message}</p>}
        </div>
        <button type="submit" disabled={isSubmitting} className={btnClass}>
          {isSubmitting ? t('invite.creatingAccount') : t('invite.createAccount')}
        </button>
      </form>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
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
