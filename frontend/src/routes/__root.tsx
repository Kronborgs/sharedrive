import { createRootRoute, isRedirect, Outlet, redirect } from '@tanstack/react-router'
import { api } from '@/lib/api'
import type { OnboardingStatus } from '@/types/api'

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    // Already heading to setup — don't redirect again (would create a loop)
    if (location.pathname.startsWith('/setup')) return
    // Check if first-run setup is needed
    try {
      const status = await api.get<OnboardingStatus>('/api/v1/system/onboarding-status')
      if (status?.required) {
        throw redirect({ to: '/setup' })
      }
    } catch (err) {
      // Re-throw router redirects — in TanStack Router v1.82+ redirect() returns
      // a Response object; use the official isRedirect() guard.
      if (isRedirect(err)) throw err
      // Otherwise allow render (network error — show error state)
    }
  },
  component: RootLayout,
})

function RootLayout() {
  return <Outlet />
}
