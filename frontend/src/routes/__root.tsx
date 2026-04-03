import { createRootRoute, Outlet, redirect } from '@tanstack/react-router'
import { api } from '@/lib/api'
import type { OnboardingStatus } from '@/types/api'

export const Route = createRootRoute({
  beforeLoad: async () => {
    // Check if first-run setup is needed — redirect unconditionally
    try {
      const status = await api.get<OnboardingStatus>('/api/v1/system/onboarding-status')
      if (status?.required) {
        throw redirect({ to: '/setup' })
      }
    } catch (err) {
      // If it's the redirect, rethrow it
      if (err && typeof err === 'object' && 'href' in err) throw err
      // Otherwise allow render (health check may have failed — show error state)
    }
  },
  component: RootLayout,
})

function RootLayout() {
  return <Outlet />
}
