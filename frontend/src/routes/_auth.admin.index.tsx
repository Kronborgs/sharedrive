import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import { APP_VERSION } from '@/version'
import type { AuditLog, PaginatedResponse } from '@/types/api'
import { formatDate, formatBytes, formatRelative } from '@/lib/utils'
import { ArrowUpCircle, ArrowDownCircle, LayoutDashboard, Activity } from 'lucide-react'
import { useI18n } from '@/lib/i18n'

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

interface IOUserStats {
  user_id: string
  email: string
  display_name: string
  upload_bytes: number
  download_bytes: number
  upload_bytes_per_sec: number
  download_bytes_per_sec: number
}

interface IOStatsResponse {
  users: IOUserStats[]
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
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState<'overview' | 'activity'>('overview')

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

  const { data: ioStats } = useQuery({
    queryKey: ['admin', 'io-stats'],
    queryFn: ({ signal }) => api.get<IOStatsResponse>('/api/v1/admin/io-stats', signal),
    refetchInterval: 3_000,
  })

  const activeUsers = (ioStats?.users ?? []).filter(
    u => u.upload_bytes_per_sec > 0 || u.download_bytes_per_sec > 0,
  )

  const diskTotal = stats?.disk_total_bytes ?? 0
  const diskFree = stats?.disk_free_bytes ?? 0
  const diskUsed = diskTotal - diskFree
  const usedPct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">
        {t('page.admin')}
      </h1>

      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <div className="flex border-b border-zinc-200 dark:border-[#2d3148]">
        <button
          type="button"
          onClick={() => setActiveTab('overview')}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'overview'
              ? 'border-brand-500 text-brand-600 dark:text-brand-400'
              : 'border-transparent text-zinc-500 dark:text-slate-400 hover:text-zinc-700 dark:hover:text-slate-200'
          }`}
        >
          <LayoutDashboard size={14} /> {t('admin.overview')}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('activity')}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'activity'
              ? 'border-brand-500 text-brand-600 dark:text-brand-400'
              : 'border-transparent text-zinc-500 dark:text-slate-400 hover:text-zinc-700 dark:hover:text-slate-200'
          }`}
        >
          <Activity size={14} /> {t('admin.recentActivity')}
        </button>
      </div>

      {/* ── Tab 1: Overview ──────────────────────────────────────────────── */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Top stat cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label={t('admin.totalUsers')} value={stats?.total_users ?? '…'} />
            <StatCard label={t('admin.activeUsers')} value={stats?.active_users ?? '…'} />
            <StatCard label={t('admin.diskUsed')} value={diskTotal > 0 ? formatBytes(diskUsed) : '…'} />
            <StatCard label={t('admin.diskCapacity')} value={diskTotal > 0 ? formatBytes(diskTotal) : '…'} />
          </div>

          {/* Storage bar */}
          {diskTotal > 0 && (
            <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-4">
              <div className="flex justify-between text-xs text-muted mb-2">
                <span>{t('admin.diskUsage')}</span>
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
            <StatCard label={t('admin.logins30d')} value={stats?.last_30_days.logins ?? '…'} small />
            <StatCard label={t('admin.failedLogins30d')} value={stats?.last_30_days.failed_logins ?? '…'} small accent="red" />
            <StatCard label={t('admin.uploads30d')} value={stats?.last_30_days.uploads ?? '…'} small accent="green" />
            <StatCard label={t('admin.downloads30d')} value={stats?.last_30_days.downloads ?? '…'} small accent="green" />
            <StatCard label={t('admin.lockouts30d')} value={stats?.last_30_days.lockouts ?? '…'} small accent="red" />
          </div>

          {/* Live I/O bandwidth panel */}
          <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-200 dark:border-[#2d3148] flex items-center justify-between">
              <h2 className="text-sm font-medium text-zinc-900 dark:text-slate-100">{t('admin.liveBandwidth')}</h2>
              <span className="text-[10px] text-muted">updates every 3 s • 2-min window</span>
            </div>
            {activeUsers.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted text-center">{t('admin.noTransfers')}</p>
            ) : (
              <div className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
                {activeUsers.map(u => (
                  <div key={u.user_id} className="px-4 py-3 flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-900 dark:text-slate-100 truncate font-medium">
                        {u.display_name || u.email}
                      </p>
                      <p className="text-xs text-muted truncate">{u.email}</p>
                    </div>
                    <div className="flex items-center gap-4 tabular-nums text-xs shrink-0">
                      {u.upload_bytes_per_sec > 0 && (
                        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <ArrowUpCircle size={14} />
                          {formatBytes(u.upload_bytes_per_sec)}/s
                        </span>
                      )}
                      {u.download_bytes_per_sec > 0 && (
                        <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400">
                          <ArrowDownCircle size={14} />
                          {formatBytes(u.download_bytes_per_sec)}/s
                        </span>
                      )}
                      <span className="text-muted hidden lg:inline">
                        ↑ {formatBytes(u.upload_bytes)} / ↓ {formatBytes(u.download_bytes)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* System version */}
          <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl px-4 py-3 flex flex-wrap gap-x-8 gap-y-1 items-center">
            <span className="text-xs text-muted font-medium uppercase tracking-wide">{t('admin.system')}</span>
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
      )}

      {/* ── Tab 2: Recent Activity ────────────────────────────────────────── */}
      {activeTab === 'activity' && (
        <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
          <div className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
            {(logs?.items ?? []).length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted text-center">{t('files.noActivity')}</p>
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
      )}
    </div>
  )
}

interface StatCardProps {
  label: string
  value: string | number
  small?: boolean
  accent?: 'red' | 'green'
}

function StatCard({ label, value, small, accent }: Readonly<StatCardProps>) {
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
