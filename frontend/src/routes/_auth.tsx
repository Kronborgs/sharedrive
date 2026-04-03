import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { useAuth } from '@/lib/auth-context'
import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { AdminBanner } from '@/components/layout/AdminBanner'

// All authenticated routes live under this layout route.
// The _auth prefix means this is a pathless layout route.
export const Route = createFileRoute('/_auth')({
  beforeLoad: async ({ context }) => {
    // If no user in context, redirect to login
    // (The AuthProvider fetches the user; this route reads from context via a custom approach)
    // We do a lightweight auth check using the API directly
    try {
      const { api } = await import('@/lib/api')
      await api.get('/api/v1/me')
    } catch {
      throw redirect({ to: '/login' })
    }
  },
  component: AuthLayout,
})

function AuthLayout() {
  const { user } = useAuth()

  if (!user) {
    return null // beforeLoad handles redirect
  }

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50 dark:bg-[#0f1117]">
      {/* Admin assistance banner — fixed at top */}
      <AdminBanner />

      {/* Sidebar */}
      <Sidebar user={user} />

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header user={user} />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
        <Footer />
      </div>
    </div>
  )
}
