import { useState, useEffect } from 'react'
import { X, ShieldCheck, Copy, Check, AlertTriangle, Loader2 } from 'lucide-react'
import QRCode from 'qrcode'
import { fetchTOTPSetup, confirmTOTPSetup, disableTOTP } from '@/lib/api'
import { toast } from 'sonner'

type Mode = 'setup' | 'disable'

interface Props {
  isEnabled: boolean
  onClose: () => void
  onChanged: () => void
}

type Step = 'qr' | 'verify' | 'backup'

export function TOTPSetupDialog({ isEnabled, onClose, onChanged }: Props) {
  const mode: Mode = isEnabled ? 'disable' : 'setup'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      {mode === 'setup' ? (
        <SetupFlow onClose={onClose} onDone={() => { onChanged(); onClose() }} />
      ) : (
        <DisableFlow onClose={onClose} onDone={() => { onChanged(); onClose() }} />
      )}
    </div>
  )
}

function SetupFlow({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<Step>('qr')
  const [secret, setSecret] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [code, setCode] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copiedCode, setCopiedCode] = useState(false)
  const [copiedSecret, setCopiedSecret] = useState(false)

  useEffect(() => {
    fetchTOTPSetup()
      .then(async data => {
        setSecret(data.secret)
        const dataUrl = await QRCode.toDataURL(data.provisioning_uri, { width: 200, margin: 2 })
        setQrDataUrl(dataUrl)
      })
      .catch(() => setError('Failed to load TOTP setup. Please try again.'))
      .finally(() => setLoading(false))
  }, [])

  const handleVerify = async (overrideCode?: string) => {
    const codeToSend = overrideCode ?? code
    if (codeToSend.length !== 6) return
    setLoading(true)
    setError(null)
    try {
      const res = await confirmTOTPSetup(codeToSend)
      setBackupCodes(res.backup_codes)
      setStep('backup')
    } catch {
      setError('Invalid code — please try again.')
      setCode('')
    } finally {
      setLoading(false)
    }
  }

  const copyBackupCodes = () => {
    void navigator.clipboard.writeText(backupCodes.join('\n'))
    setCopiedCode(true)
    setTimeout(() => setCopiedCode(false), 2000)
  }

  const copySecret = () => {
    void navigator.clipboard.writeText(secret)
    setCopiedSecret(true)
    setTimeout(() => setCopiedSecret(false), 2000)
  }

  return (
    <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-2xl shadow-2xl w-full max-w-md">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-[#2d3148]">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-brand-600 dark:text-brand-400" />
          <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100">
            Set up two-factor authentication
          </h2>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148]">
          <X size={16} />
        </button>
      </div>

      <div className="p-5">
        {/* Step: QR */}
        {step === 'qr' && (
          <div className="space-y-4">
            <p className="text-sm text-zinc-600 dark:text-slate-400">
              Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.), then click <strong>Next</strong>.
            </p>
            {loading && (
              <div className="flex justify-center py-8">
                <Loader2 size={32} className="animate-spin text-brand-500" />
              </div>
            )}
            {error && (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}
            {!loading && qrDataUrl && (
              <>
                <div className="flex justify-center">
                  <img src={qrDataUrl} alt="TOTP QR code" className="rounded-lg border border-zinc-200 dark:border-[#2d3148]" width={200} height={200} />
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-zinc-500 dark:text-slate-500">Or enter the key manually:</p>
                  <div className="flex items-center gap-2 bg-zinc-50 dark:bg-[#0f1117] rounded-lg px-3 py-2 border border-zinc-200 dark:border-[#2d3148]">
                    <code className="flex-1 text-xs font-mono text-zinc-800 dark:text-slate-200 break-all">{secret}</code>
                    <button onClick={copySecret} className="shrink-0 text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400">
                      {copiedSecret ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
                <button
                  onClick={() => setStep('verify')}
                  className="w-full py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors"
                >
                  Next — enter verification code
                </button>
              </>
            )}
          </div>
        )}

        {/* Step: Verify */}
        {step === 'verify' && (
          <div className="space-y-4">
            <p className="text-sm text-zinc-600 dark:text-slate-400">
              Enter the 6-digit code from your authenticator app to confirm setup.
            </p>
            {error && (
              <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
                <AlertTriangle size={14} />
                {error}
              </div>
            )}
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoFocus
              value={code}
              onChange={e => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 6)
                setCode(val)
                if (val.length === 6) {
                  void handleVerify(val)
                }
              }}
              onKeyDown={e => { if (e.key === 'Enter') void handleVerify() }}
              autoComplete="one-time-code"
              className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-2 text-center text-2xl tracking-widest font-mono text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="000000"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setStep('qr')}
                className="flex-1 py-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-zinc-600 dark:text-slate-400 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => void handleVerify()}
                disabled={code.length !== 6 || loading}
                className="flex-1 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                {loading ? 'Verifying…' : 'Confirm'}
              </button>
            </div>
          </div>
        )}

        {/* Step: Backup codes */}
        {step === 'backup' && (
          <div className="space-y-4">
            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              Save your backup codes now — they will not be shown again. Each code can only be used once.
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {backupCodes.map(c => (
                <code key={c} className="bg-zinc-50 dark:bg-[#0f1117] border border-zinc-200 dark:border-[#2d3148] rounded px-2 py-1 text-xs font-mono text-center text-zinc-800 dark:text-slate-200">
                  {c}
                </code>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={copyBackupCodes}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-zinc-600 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
              >
                {copiedCode ? <Check size={14} /> : <Copy size={14} />}
                Copy all
              </button>
              <button
                onClick={onDone}
                className="flex-1 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors"
              >
                Done — 2FA is now active
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function DisableFlow({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [loading, setLoading] = useState(false)

  const handleDisable = async () => {
    setLoading(true)
    try {
      await disableTOTP()
      toast.success('Two-factor authentication disabled')
      onDone()
    } catch {
      toast.error('Failed to disable 2FA')
      setLoading(false)
    }
  }

  return (
    <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-2xl shadow-2xl w-full max-w-sm">
      <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-[#2d3148]">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100">Disable two-factor authentication</h2>
        <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148]">
          <X size={16} />
        </button>
      </div>
      <div className="p-5 space-y-4">
        <p className="text-sm text-zinc-600 dark:text-slate-400">
          This will remove the extra layer of protection from your account. Are you sure?
        </p>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-zinc-600 dark:text-slate-400 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors">
            Cancel
          </button>
          <button
            onClick={() => void handleDisable()}
            disabled={loading}
            className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {loading ? 'Disabling…' : 'Disable 2FA'}
          </button>
        </div>
      </div>
    </div>
  )
}
