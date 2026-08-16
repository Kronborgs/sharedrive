import { createFileRoute, redirect, isRedirect } from '@tanstack/react-router'

// Root index: redirect authenticated users to /files (guests to /shares), others to /login.
export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const { api } = await import('@/lib/api')
    try {
      const user = await api.get<{ role: string; rooms_only_account?: boolean }>('/api/v1/me')
      if (user.role === 'guest') {
        throw redirect({ to: user.rooms_only_account ? '/rooms' : '/shares' })
      }
      throw redirect({ to: '/files' })
    } catch (e) {
      if (isRedirect(e)) throw e
      // Not authenticated — the _auth layout will redirect to /login
      throw redirect({ to: '/files' })
    }
  },
  component: () => null,
})
