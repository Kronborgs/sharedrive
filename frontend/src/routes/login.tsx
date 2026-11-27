import { createFileRoute, Outlet } from '@tanstack/react-router'
import { ThemeSelect } from '@/components/layout/ThemeSelect'

export const Route = createFileRoute('/login')({
  component: LoginLayout,
})

function LoginLayout() {
  return (
    <div className="login-layout grid min-h-dvh grid-rows-[auto_1fr]">
      <header className="flex items-center justify-between gap-4 px-4 py-4 sm:px-8 sm:py-6">
        <img src="/logo_name.png" alt="Sharedrive" className="h-8 w-auto max-w-[45%] rounded-lg object-contain object-left sm:h-10" />
        <ThemeSelect />
      </header>
      <main className="grid place-items-center px-4 pb-8 pt-2 sm:pb-24">
        <div className="login-card w-full max-w-[27rem] rounded-[1.75rem] border p-6 shadow-2xl sm:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
