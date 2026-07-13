import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '@/lib/api'
import type { BlockedIP, IPWhitelistEntry } from '@/types/api'
import { formatDate } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'

export const Route = createFileRoute('/_auth/admin/blocked-ips/')({
  component: BlockedIPsPage,
})

function BlockedIPsPage() {
  const qc = useQueryClient()
  const { t } = useI18n()

  const { data: blocked, isLoading: loadingBlocked } = useQuery({
    queryKey: ['admin', 'blocked-ips'],
    queryFn: ({ signal }) => api.get<BlockedIP[]>('/api/v1/admin/blocked-ips', signal),
  })

  const { data: whitelist, isLoading: loadingWhitelist } = useQuery({
    queryKey: ['admin', 'ip-whitelist'],
    queryFn: ({ signal }) => api.get<IPWhitelistEntry[]>('/api/v1/admin/ip-whitelist', signal),
  })

  const unblock = useMutation({
    mutationFn: (ip: string) =>
      api.delete(`/api/v1/admin/blocked-ips/${encodeURIComponent(ip)}`),
    onSuccess: () => { ignorePromise(qc.invalidateQueries({ queryKey: ['admin', 'blocked-ips'] })) },
  })

  const removeWhitelist = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/ip-whitelist/${id}`),
    onSuccess: () => { ignorePromise(qc.invalidateQueries({ queryKey: ['admin', 'ip-whitelist'] })) },
  })

  const [newCIDR, setNewCIDR] = useState('')
  const [newDesc, setNewDesc] = useState('')

  const addWhitelist = useMutation({
    mutationFn: () => api.post('/api/v1/admin/ip-whitelist', { ip_cidr: newCIDR, description: newDesc }),
    onSuccess: () => {
      ignorePromise(qc.invalidateQueries({ queryKey: ['admin', 'ip-whitelist'] }))
      setNewCIDR('')
      setNewDesc('')
    },
  })

  const tierLabel: Record<string, string> = {
    '60m':    '60-minute lockout',
    '6h':     '6-hour lockout',
    '24h':    '24-hour lockout',
    'manual': 'Manual block (admin unblock required)',
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">
        {t('blocked.title')}
      </h1>

      {/* Blocked IPs */}
      <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-[#2d3148] flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-slate-100">{t('blocked.activeLockouts')}</h2>
          <span className="text-xs text-muted">{blocked?.length ?? 0} active</span>
        </div>
        {loadingBlocked ? (
          <div className="p-6 text-sm text-muted text-center">{t('blocked.loading')}</div>
        ) : blocked?.length === 0 ? (
          <div className="p-6 text-sm text-muted text-center">{t('blocked.noLockouts')}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117]">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">{t('blocked.colIp')}</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">{t('blocked.colTier')}</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">{t('blocked.colAttempts')}</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">{t('blocked.colExpires')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
              {blocked?.map(b => (
                <tr key={b.ip} className="hover:bg-zinc-50 dark:hover:bg-[#0f1117]">
                  <td className="px-4 py-3 font-mono text-sm">{b.ip}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                      b.tier === 'manual'
                        ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                        : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                    }`}>
                      {tierLabel[b.tier] ?? b.tier}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 dark:text-red-400">
                      {b.attempt_count}
                      <span className="font-normal text-muted">{t('blocked.attempts')}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {b.ttl_seconds == null
                      ? t('blocked.neverManual')
                      : t('blocked.inNMin', { n: String(Math.ceil(b.ttl_seconds / 60)) })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => unblock.mutate(b.ip)}
                      disabled={unblock.isPending}
                      className="text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                    >
                      {t('blocked.unblock')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* IP Whitelist */}
      <section className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-[#2d3148]">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-slate-100">{t('blocked.whitelist')}</h2>
          <p className="text-xs text-muted mt-0.5">
            {t('blocked.whitelistDesc')}
          </p>
        </div>

        {/* Add form */}
        <div className="px-4 py-3 border-b border-zinc-100 dark:border-[#2d3148] flex gap-2">
          <input
            value={newCIDR}
            onChange={e => setNewCIDR(e.target.value)}
            placeholder={t('blocked.cidrPlaceholder')}
            className="flex-1 rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <input
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            placeholder={t('blocked.descPlaceholder')}
            className="flex-1 rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <button
            onClick={() => addWhitelist.mutate()}
            disabled={!newCIDR || addWhitelist.isPending}
            className="px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {t('blocked.add')}
          </button>
        </div>

        {loadingWhitelist ? (
          <div className="p-6 text-sm text-muted text-center">{t('blocked.loading')}</div>
        ) : whitelist?.length === 0 ? (
          <div className="p-6 text-sm text-muted text-center">{t('blocked.noWhitelist')}</div>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
              {whitelist?.map(entry => (
                <tr key={entry.id} className="hover:bg-zinc-50 dark:hover:bg-[#0f1117]">
                  <td className="px-4 py-3 font-mono">{entry.ip_cidr}</td>
                  <td className="px-4 py-3 text-muted text-xs">{entry.description || '—'}</td>
                  <td className="px-4 py-3 text-xs text-muted">{formatDate(entry.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => removeWhitelist.mutate(entry.id)}
                      disabled={removeWhitelist.isPending}
                      className="text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                    >
                      {t('blocked.remove')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
