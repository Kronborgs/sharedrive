import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import type { AuditLog, PaginatedResponse } from '@/types/api'
import { formatRelative, formatDate } from '@/lib/utils'
import { z } from 'zod'

const searchSchema = z.object({
  page: z.number().catch(1),
  event: z.string().catch(''),
  user: z.string().catch(''),
})

export const Route = createFileRoute('/_auth/admin/audit-logs/')({
  validateSearch: searchSchema,
  component: AuditLogsPage,
})

const EVENT_TYPES = [
  '',
  'user.login',
  'user.logout',
  'user.login_failed',
  'user.created',
  'user.updated',
  'user.deleted',
  'file.uploaded',
  'file.downloaded',
  'file.deleted',
  'file.moved',
  'file.trashed',
  'file.restored',
  'share.created',
  'share.revoked',
  'admin.support_access',
  'admin.user_quota_changed',
]

function eventColor(event: string): string {
  if (event.includes('fail') || event.includes('delete') || event.includes('revoke')) {
    return 'text-red-600 dark:text-red-400'
  }
  if (event.includes('login') || event.includes('upload') || event.includes('create')) {
    return 'text-emerald-600 dark:text-emerald-400'
  }
  if (event.includes('admin')) {
    return 'text-amber-600 dark:text-amber-400'
  }
  return 'text-zinc-500 dark:text-slate-400'
}

export function AuditLogsPage() {
  const navigate = Route.useNavigate()
  const { page, event, user } = Route.useSearch()

  const [userFilter, setUserFilter] = useState<string>(user)
  const limit = 50

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'audit-logs', page, event, user],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String((page - 1) * limit),
      })
      if (event) params.set('event_type', event)
      if (user) params.set('actor_email', user)
      return api.get<PaginatedResponse<AuditLog>>(`/api/v1/admin/audit-logs?${params}`, signal)
    },
  })

  const logs = data?.items ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / limit))

  const setPage = (p: number) => void navigate({ search: (prev: typeof searchSchema._output) => ({ ...prev, page: p }) })
  const setEvent = (e: string) => void navigate({ search: (prev: typeof searchSchema._output) => ({ ...prev, event: e, page: 1 }) })
  const setUser = (u: string) => void navigate({ search: (prev: typeof searchSchema._output) => ({ ...prev, user: u, page: 1 }) })

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">Audit Log</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <select
          value={event}
          onChange={e => setEvent(e.target.value)}
          className="text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] text-zinc-900 dark:text-slate-100 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          {EVENT_TYPES.map(t => (
            <option key={t} value={t}>{t || 'All events'}</option>
          ))}
        </select>
        <form
          className="flex gap-1.5"
          onSubmit={e => { e.preventDefault(); setUser(userFilter) }}
        >
          <input
            value={userFilter}
            onChange={e => setUserFilter(e.target.value)}
            placeholder="Filter by email…"
            className="text-sm rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] text-zinc-900 dark:text-slate-100 px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand-500 w-52"
          />
          <button
            type="submit"
            className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors"
          >
            Search
          </button>
          {user && (
            <button
              type="button"
              onClick={() => { setUserFilter(''); setUser('') }}
              className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-muted hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
            >
              Clear
            </button>
          )}
        </form>
        <span className="ml-auto text-xs text-muted self-center">{total} total events</span>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted">Loading…</div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted">No audit events found</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117]">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase w-36">Time</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Event</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Actor</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Target</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase hidden md:table-cell">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
              {logs.map(log => (
                <tr key={log.id} className="hover:bg-zinc-50 dark:hover:bg-[#0f1117]">
                  <td className="px-4 py-2.5 text-xs text-muted whitespace-nowrap" title={formatDate(log.created_at)}>
                    {formatRelative(log.created_at)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`font-mono text-xs ${eventColor(log.event_type)}`}>
                      {log.event_type}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted max-w-[160px] truncate" title={log.actor_email ?? undefined}>
                    {log.actor_email ?? <em>system</em>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted max-w-[160px] truncate" title={log.target_email ?? undefined}>
                    {log.target_email ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted font-mono hidden md:table-cell">
                    {log.ip_address ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1">
          <button
            onClick={() => setPage(page - 1)}
            disabled={page === 1}
            className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm disabled:opacity-40 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
          >
            Prev
          </button>
          <span className="text-sm text-muted px-2">Page {page} of {totalPages}</span>
          <button
            onClick={() => setPage(page + 1)}
            disabled={page === totalPages}
            className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm disabled:opacity-40 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
