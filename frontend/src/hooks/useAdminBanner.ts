import { useState } from 'react'
import { useSSE } from './useSSE'
import { useAuth } from '@/lib/auth-context'

interface AdminBannerEvent {
  type: 'admin_session_active' | 'admin_session_ended'
  target_user_email: string
}

export function useAdminBanner() {
  const { user } = useAuth()
  const [active, setActive] = useState(false)
  const [targetUser, setTargetUser] = useState('')
  const [dismissed, setDismissed] = useState(false)

  useSSE<AdminBannerEvent>({
    url: '/api/v1/admin/support-session/events',
    enabled: !!user && !user.is_admin, // only shown to the account being accessed
    onMessage: (event) => {
      if (event.type === 'admin_session_active') {
        setTargetUser(event.target_user_email)
        setActive(true)
        setDismissed(false)
      } else if (event.type === 'admin_session_ended') {
        setActive(false)
      }
    },
  })

  const dismiss = () => setDismissed(true)

  return { active: active && !dismissed, targetUser, dismiss }
}
