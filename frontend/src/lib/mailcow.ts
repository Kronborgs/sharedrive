import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { User } from '@/types/api'

export const mailcowFeatureKey = ['mailcow-feature']
export const mailcowAdminEndpoint = '/api/v1/admin/mailcow'

export type MailcowStatus = { enabled: boolean; ready: boolean }

export function useMailcowEnabled(user?: User | null) {
  const query = useQuery({
    queryKey: [...mailcowFeatureKey, user?.id],
    queryFn: ({ signal }) => api.get<MailcowStatus>('/api/v1/mailcow/status', signal),
    enabled: Boolean(user && user.role !== 'guest' && !user.rooms_only_account),
    retry: false,
  })
  return Boolean(user && query.data?.enabled)
}
