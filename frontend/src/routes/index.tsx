import { createFileRoute, redirect } from '@tanstack/react-router'

// Root index: redirect authenticated users to /files, others to /login.
// Actual auth check is done by the /files route's beforeLoad.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/files' })
  },
  component: () => null,
})
