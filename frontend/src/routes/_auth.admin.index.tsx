import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { AuditLog, User, PaginatedResponse } from '@/types/api'
import { formatDate, formatBytes } from '@/lib/utils'

export const Route = createFileRoute('/_auth/admin/')({
  component: AdminDashboard,
})

function AdminDashboard() {
  const { data: users } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: ({ signal }) => api.get<PaginatedResponse<User>>('/api/v1/admin/users', signal),
  })

  const { data: logs } = useQuery({
    queryKey: ['admin', 'audit-logs', 'recent'],
    queryFn: ({ signal }) =>
      api.get<PaginatedResponse<AuditLog>>('/api/v1/admin/audit-logs?limit=10', signal),
  })

  const totalUsers = users?.total ?? 0
  const activeUsers = users?.items.filter(u => u.is_active).length ?? 0
  const totalUsage = users?.items.reduce((sum, u) => sum + u.quota_used_bytes, 0) ?? 0
  const totalQuota = users?.items.reduce((sum, u) => sum + u.quota_bytes, 0) ?? 0

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">
        Admin Dashboard
      </h1>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Users" value={totalUsers} />
        <StatCard label="Active Users" value={activeUsers} />
        <StatCard label="Storage Used" value={formatBytes(totalUsage)} />
        <StatCard
          label="Storage Capacity"
          value={formatBytes(totalQuota)}
        />
      </div>

      {/* Recent activity */}
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-[#2d3148]">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-slate-100">
            Recent Activity
          </h2>
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
          {logs?.items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted text-center">No activity yet</p>
          ) : (
            logs?.items.map(log => (
              <div key={log.id} className="px-4 py-3 flex items-start gap-3">
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 shrink-0">
                  {log.event_type}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-700 dark:text-slate-300 truncate">
                    {log.actor_email || 'System'}
                    {log.resource_name ? ` → ${log.resource_name}` : ''}
                  </p>
                  <p className="text-xs text-muted">{log.ip_address}</p>
                </div>
                <span className="text-xs text-muted shrink-0">
                  {formatDate(log.created_at)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4">
      <p className="text-xs text-muted font-medium uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-semibold text-zinc-900 dark:text-slate-100 mt-1">{value}</p>
    </div>
  )
}
