import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { User } from '@/types/api'

export const mailcowFeatureKey = ['mailcow-feature']
export const mailcowAdminEndpoint = '/api/v1/admin/mailcow'
export const mailcowAccountEndpoint = '/api/v1/me/mailcow'
export const mailcowTabs = ['inbox', 'calendar', 'contacts'] as const
export const mailcowAccountKey = (userId?: string) => ['mailcow-account', userId] as const

export type MailcowTab = typeof mailcowTabs[number]
export type MailcowStatus = { enabled: boolean; ready: boolean }
export type MailcowAccount = { host: string; username: string }
export type MailcowAccountState = MailcowStatus & { account: MailcowAccount | null }
export type MailcowProbeResult = Record<'imap' | 'smtp' | 'caldav' | 'carddav', 'ok' | 'failed'>
export type MailcowConnection = { account: MailcowAccount | null; protocols: MailcowProbeResult }

export function useMailcowAccount(userId?: string, enabled = true) {
  return useQuery({
    queryKey: mailcowAccountKey(userId),
    queryFn: ({ signal }) => api.get<MailcowAccountState>(mailcowAccountEndpoint, signal),
    enabled: Boolean(userId) && enabled,
    retry: false,
  })
}

export function useMailcowNavigation(user?: User | null) {
  const eligible = Boolean(user && user.role !== 'guest' && !user.rooms_only_account)
  const feature = useQuery({
    queryKey: [...mailcowFeatureKey, user?.id],
    queryFn: ({ signal }) => api.get<MailcowStatus>('/api/v1/mailcow/status', signal),
    enabled: eligible,
    retry: false,
  })
  const enabled = eligible && feature.data?.enabled === true
  const account = useMailcowAccount(user?.id, enabled)
  return { enabled, connected: Boolean(account.data?.account), loading: account.isPending }
}
