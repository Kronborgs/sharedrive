import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { api, ApiClientError } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'

const searchSchema = z.object({
  pending_token: z.string(),
  trust_device: z.boolean().optional().default(false),
})

export const Route = createFileRoute('/login/totp')({
  validateSearch: searchSchema,
  component: TOTPPage,
})

export default function TOTPPage() {
  const { pending_token, trust_device } = Route.useSearch()
  const navigate = useNavigate()
  const { refetch } = useAuth()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const onSubmitCode = async (codeToSend: string) => {
    setError(null)
    setIsSubmitting(true)
    try {
      await api.post('/api/v1/auth/totp/verify', { pending_token, code: codeToSend, trust_device })
      await refetch()
      await navigate({ to: '/files' })
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message)
      } else {
        setError('An unexpected error occurred. Please try again.')
      }
      setCode('')
    } finally {
      setIsSubmitting(false)
    }
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    void onSubmitCode(code)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-[#0f1117] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">
            Two-factor authentication
          </h1>
          <p className="text-sm text-muted mt-1">
            Enter the 6-digit code from your authenticator app
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-6 space-y-4 shadow-sm"
        >
          {error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="space-y-1">
            <label className="block text-sm font-medium text-zinc-700 dark:text-slate-300">
              Authentication code
            </label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={code}
              onChange={e => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 6)
                setCode(val)
                if (val.length === 6) {
                  // auto-submit so the code doesn't expire while user reaches for button
                  void onSubmitCode(val)
                }
              }}
              autoComplete="one-time-code"
              autoFocus
              className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-2 text-center text-xl tracking-widest font-mono text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="000000"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting || code.length !== 6}
            className="w-full rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white font-medium py-2 text-sm transition-colors"
          >
            {isSubmitting ? 'Verifying…' : 'Verify'}
          </button>

          <div className="text-center">
            <a href="/login" className="text-xs text-brand-600 dark:text-brand-400 hover:underline">
              ← Back to login
            </a>
          </div>
        </form>
      </div>
    </div>
  )
}
