import { createFileRoute, Outlet } from '@tanstack/react-router'

// login.tsx is a thin layout parent for /login children:
//   /login/      → login.index.tsx (the actual login form)
//   /login/totp  → login.totp.tsx  (the 2FA step)
// Without this layout the TOTP child route would never render.
export const Route = createFileRoute('/login')({
  component: () => <Outlet />,
})
