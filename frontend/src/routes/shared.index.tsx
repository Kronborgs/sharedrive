import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { api } from '@/lib/api'
import type { FileItem, Share } from '@/types/api'
import { formatBytes, formatDate } from '@/lib/utils'
import { Download, Lock } from 'lucide-react'
import { useState } from 'react'

const searchSchema = z.object({
  token: z.string().catch(''),
})

interface SharedPayload {
  share: Share
  item: FileItem
  items?: FileItem[] // if item is a folder
}

export const Route = createFileRoute('/shared/')({
  validateSearch: searchSchema,
  component: SharedPage,
})

function SharedPage() {
  const { token } = Route.useSearch()
  const [password, setPassword] = useState('')
  const [submittedPassword, setSubmittedPassword] = useState<string | undefined>(undefined)
  const [passwordError, setPasswordError] = useState(false)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['shared', token, submittedPassword],
    queryFn: ({ signal }) =>
      api.get<SharedPayload>(
        `/api/v1/public/shared/${token}${submittedPassword ? `?password=${encodeURIComponent(submittedPassword)}` : ''}`,
        signal,
      ),
    enabled: !!token,
    retry: false,
  })

  if (!token) {
    return <Shell><p className="text-sm text-red-500 text-center">Invalid link.</p></Shell>
  }

  if (isLoading) {
    return <Shell><p className="text-sm text-muted text-center">Loading…</p></Shell>
  }

  // Password required (403)
  const httpError = error as { status?: number } | null
  if (isError && httpError?.status === 403 && submittedPassword === undefined) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3">
          <Lock size={28} className="text-zinc-400" />
          <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100">Password protected</h2>
          <p className="text-sm text-muted">Enter the password to access this shared item.</p>
          <form
            className="w-full space-y-3"
            onSubmit={e => {
              e.preventDefault()
              setPasswordError(false)
              setSubmittedPassword(password)
            }}
          >
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Password"
              className={inputClass}
              autoFocus
            />
            {passwordError && <p className="text-xs text-red-500">Incorrect password</p>}
            <button type="submit" className={btnClass}>Access file</button>
          </form>
        </div>
      </Shell>
    )
  }

  if (isError) {
    return (
      <Shell>
        <p className="text-sm text-red-500 text-center">
          This shared link is invalid or has expired.
        </p>
      </Shell>
    )
  }

  if (!data) return null

  const { share, item, items } = data
  const downloadUrl = `/api/v1/public/shared/${token}/download`

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-[#0f1117] flex flex-col">
      <header className="bg-white dark:bg-[#1a1d27] border-b border-zinc-200 dark:border-[#2d3148] px-6 h-14 flex items-center">
        <img src="/logo_name.png" alt="Sharedrive" className="h-7 w-auto" />
        <span className="ml-3 text-sm text-muted">Shared with you</span>
      </header>

      <main className="flex-1 flex items-start justify-center p-6">
        <div className="w-full max-w-2xl bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-2xl shadow-sm overflow-hidden">
          {/* Item header */}
          <div className="p-5 border-b border-zinc-100 dark:border-[#2d3148] flex items-center gap-3">
            <span className="text-3xl">{item.is_folder ? '📁' : '📄'}</span>
            <div className="flex-1 min-w-0">
              <h1 className="text-base font-semibold text-zinc-900 dark:text-slate-100 truncate">{item.name}</h1>
              <p className="text-xs text-muted">
                {item.is_folder ? 'Folder' : formatBytes(item.size_bytes)}
                {share.expires_at && ` · Expires ${formatDate(share.expires_at)}`}
              </p>
            </div>
            {share.can_view && !item.is_folder && (
              <a
                href={downloadUrl}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors"
                download
              >
                <Download size={14} />
                Download
              </a>
            )}
          </div>

          {/* Folder contents */}
          {item.is_folder && items && items.length > 0 && (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-zinc-100 dark:divide-[#2d3148]">
                {items.map(f => (
                  <tr key={f.id} className="hover:bg-zinc-50 dark:hover:bg-[#2d3148]/50">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span>{f.is_folder ? '📁' : '📄'}</span>
                        <span className="text-zinc-900 dark:text-slate-100 truncate">{f.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-muted tabular-nums">
                      {f.is_folder ? '—' : formatBytes(f.size_bytes)}
                    </td>
                    {share.can_view && !f.is_folder && (
                      <td className="px-4 py-2.5 text-right">
                        <a
                          href={`/api/v1/public/shared/${token}/download?file_id=${f.id}`}
                          className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
                          download
                        >
                          Download
                        </a>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {item.is_folder && (!items || items.length === 0) && (
            <div className="p-8 text-center text-sm text-muted">This folder is empty</div>
          )}
        </div>
      </main>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-[#0f1117] flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-2xl p-6 shadow-sm">
        <div className="text-center mb-4">
          <img src="/logo_name.png" alt="Sharedrive" className="h-7 w-auto mx-auto" />
        </div>
        {children}
      </div>
    </div>
  )
}

const inputClass =
  'w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-2 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500'
const btnClass =
  'w-full px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors'
