import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_auth/admin/groups/')({
  beforeLoad: () => { throw redirect({ to: '/admin/users' }) },
  component: () => null,
})
