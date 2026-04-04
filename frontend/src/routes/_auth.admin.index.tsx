import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { APP_VERSION } from '@/version'
import type { AuditLog, PaginatedResponse } from '@/types/api'
import { formatDate, formatBytes, formatRelative } from '@/lib/utils'

export const Route = createFileRoute('/_auth/admin/')({
  component: AdminDashboard,
})

interface DashboardStats {
  total_users: number
  active_users: number
  storage_used_bytes: number
  disk_total_bytes: number
  disk_free_bytes: number
  last_30_days: {
    logins: number
    failed_logins: number
    uploads: number
    downloads: number
    lockouts: number
  }
}

// Colour coding for audit log event types
function eventBadgeClass(eventType: string): string {
  if (eventType.startsWith('LOCKOUT') || eventType === 'LOGIN_FAILED')
    return 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400'
  if (eventType === 'LOGIN_SUCCESS' || eventType === 'LOGOUT')
    return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
  if (eventType.startsWith('FILE_'))
    return 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
  return 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
}

function AdminDashboard() {
  const { data: stats } = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: ({ signal }) => api.get<DashboardStats>('/api/v1/admin/stats', signal),
    refetchInterval: 30_000,
  })

  const { data: logs } = useQuery({
    queryKey: ['admin', 'audit-logs', 'recent'],
    queryFn: ({ signal }) =>
      api.get<PaginatedResponse<AuditLog>>('/api/v1/admin/audit-logs?limit=15', signal),
    refetchInterval: 30_000,
  })

  const { data: versionInfo } = useQuery({
    queryKey: ['system', 'version'],
    queryFn: ({ signal }) =>
      api.get<{ version: string; build_date: string }>('/api/v1/system/version', signal),
    staleTime: Infinity,
  })

  const used = stats?.storage_used_bytes ?? 0
  const diskTotal = stats?.disk_total_bytes ?? 0
  const diskFree = stats?.disk_free_bytes ?? 0
  const diskUsed = diskTotal > 0 ? diskTotal - diskFree : used
  const usedPct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">
        Admin Dashboard
      </h1>

      {/* Top stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Users" value={stats?.total_users ?? '…'} />
        <StatCard label="Active Users" value={stats?.active_users ?? '…'} />
        <StatCard label="Storage Used" value={used > 0 ? formatBytes(used) : '0 B'} />
        <StatCard label="Disk Capacity" value={diskTotal > 0 ? formatBytes(diskTotal) : '…'} />
      </div>

      {/* Storage bar */}
      {diskTotal > 0 && (
        <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4">
          <div className="flex justify-between text-xs text-muted mb-2">
            <span>Disk usage</span>
            <span>{formatBytes(diskUsed)} / {formatBytes(diskTotal)} ({usedPct}%) — {formatBytes(diskFree)} free</span>
          </div>
          <div className="h-2 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-500 rounded-full transition-all"
              style={{ width: `${Math.min(usedPct, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Activity counts — last 30 days */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Logins (30d)" value={stats?.last_30_days.logins ?? '…'} small />
        <StatCard label="Failed logins (30d)" value={stats?.last_30_days.failed_logins ?? '…'} small accent="red" />
        <StatCard label="Uploads (30d)" value={stats?.last_30_days.uploads ?? '…'} small accent="green" />
        <StatCard label="Downloads (30d)" value={stats?.last_30_days.downloads ?? '…'} small accent="green" />
        <StatCard label="Lockouts (30d)" value={stats?.last_30_days.lockouts ?? '…'} small accent="red" />
      </div>

      {/* Recent activity */}
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-[#2d3148]">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-slate-100">Recent Activity</h2>
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
          {(logs?.items ?? []).length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted text-center">No activity yet</p>
          ) : (
            (logs?.items ?? []).map(log => (
              <div key={log.id} className="px-4 py-3 flex items-start gap-3">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono shrink-0 ${eventBadgeClass(log.event_type)}`}>
                  {log.event_type}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-700 dark:text-slate-300 truncate">
                    {log.actor_email || 'System'}
                    {log.resource_name ? ` → ${log.resource_name}` : ''}
                  </p>
                  <p className="text-xs text-muted">{log.ip_address}</p>
                </div>
                <span className="text-xs text-muted shrink-0" title={formatDate(log.created_at)}>
                  {formatRelative(log.created_at)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* System version */}
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl px-4 py-3 flex flex-wrap gap-x-8 gap-y-1 items-center">
        <span className="text-xs text-muted font-medium uppercase tracking-wide">System</span>
        <span className="text-xs text-zinc-700 dark:text-slate-300 font-mono">
          frontend&nbsp;<span className="text-zinc-500 dark:text-slate-500">{APP_VERSION}</span>
        </span>
        <span className="text-xs text-zinc-700 dark:text-slate-300 font-mono">
          backend&nbsp;<span className="text-zinc-500 dark:text-slate-500">{versionInfo?.version ?? '…'}</span>
        </span>
        {versionInfo?.build_date && (
          <span className="text-xs text-zinc-700 dark:text-slate-300 font-mono">
            built&nbsp;<span className="text-zinc-500 dark:text-slate-500">{versionInfo.build_date}</span>
          </span>
        )}
      </div>
    </div>
  )
}

interface StatCardProps {
  label: string
  value: string | number
  small?: boolean
  accent?: 'red' | 'green'
}

function StatCard({ label, value, small, accent }: StatCardProps) {
  const valueClass = accent === 'red'
    ? 'text-red-600 dark:text-red-400'
    : accent === 'green'
    ? 'text-green-600 dark:text-green-400'
    : 'text-zinc-900 dark:text-slate-100'
  return (
    <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4">
      <p className="text-xs text-muted font-medium uppercase tracking-wide">{label}</p>
      <p className={`font-semibold mt-1 ${small ? 'text-xl' : 'text-2xl'} ${valueClass}`}>{value}</p>
    </div>
  )
}
