import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { User, PaginatedResponse } from '@/types/api'
import { formatBytes, formatDate } from '@/lib/utils'

export const Route = createFileRoute('/_auth/admin/users/')({
  component: AdminUsersPage,
})

function AdminUsersPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: ({ signal }) => api.get<PaginatedResponse<User>>('/api/v1/admin/users', signal),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">Users</h1>
        <button className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors">
          Invite user
        </button>
      </div>

      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-40 text-sm text-muted">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117]">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">User</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">Role</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">Quota</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">Last login</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase tracking-wide">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
              {data?.items.map(user => (
                <UserRow key={user.id} user={user} />
              ))}
              {data?.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-muted">No users found</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function UserRow({ user }: { user: User }) {
  const percent = user.quota_bytes > 0
    ? Math.min(100, (user.quota_used_bytes / user.quota_bytes) * 100)
    : 0

  return (
    <tr className="hover:bg-zinc-50 dark:hover:bg-[#0f1117] transition-colors">
      <td className="px-4 py-3">
        <div>
          <p className="font-medium text-zinc-900 dark:text-slate-100">{user.display_name}</p>
          <p className="text-xs text-muted">{user.email}</p>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
          user.role === 'admin'
            ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'
            : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
        }`}>
          {user.role}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="space-y-1 min-w-[120px]">
          <div className="flex justify-between text-xs text-muted">
            <span>{formatBytes(user.quota_used_bytes)}</span>
            <span>{formatBytes(user.quota_bytes)}</span>
          </div>
          <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                percent > 90 ? 'bg-red-500' : percent > 70 ? 'bg-amber-500' : 'bg-brand-500'
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-xs text-muted">
        {user.last_login_at ? formatDate(user.last_login_at) : '—'}
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center gap-1 text-xs ${
          user.is_active ? 'text-green-600 dark:text-green-400' : 'text-zinc-400'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${user.is_active ? 'bg-green-500' : 'bg-zinc-400'}`} />
          {user.is_active ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <a
          href={`/admin/users/${user.id}`}
          className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
        >
          Edit
        </a>
      </td>
    </tr>
  )
}
