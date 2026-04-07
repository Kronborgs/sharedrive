import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { useAuth } from '@/lib/auth-context'
import { useState } from 'react'
import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { AdminBanner } from '@/components/layout/AdminBanner'
import { TOTPSetupDialog } from '@/components/layout/TOTPSetupDialog'

// All authenticated routes live under this layout route.
// The _auth prefix means this is a pathless layout route.
export const Route = createFileRoute('/_auth')({
  beforeLoad: async () => {
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
  const { user, refetch } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  if (!user) {
    return null // beforeLoad handles redirect
  }

  const needsTOTPSetup = !!user.force_totp_setup && !user.totp_enabled

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50 dark:bg-[#0f1117]">
      {/* Admin assistance banner — fixed at top */}
      <AdminBanner />

      {/* Sidebar */}
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header user={user} onMenuToggle={() => setSidebarOpen(v => !v)} />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
        <Footer />
      </div>

      {/* Non-dismissible TOTP setup gate when admin has required it */}
      {needsTOTPSetup && (
        <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center">
          <div className="text-center mb-4 absolute top-8 left-0 right-0">
            <p className="text-white text-sm font-medium">
              Your administrator requires you to set up two-factor authentication before continuing.
            </p>
          </div>
          <TOTPSetupDialog
            isEnabled={false}
            onClose={() => {/* non-dismissible */}}
            onChanged={() => void refetch()}
          />
        </div>
      )}
    </div>
  )
}
