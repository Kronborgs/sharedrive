import { useEffect, useState } from 'react'
import { X, ShieldCheck, Copy, Check, AlertTriangle, Loader2, Trash2, Plus } from 'lucide-react'
import QRCode from 'qrcode'
import { deleteMFAMethod, fetchMFAMethods, fetchTOTPSetup, confirmTOTPSetup, requestEmailMFA, confirmEmailMFA, type MFAMethod } from '@/lib/api'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'

interface Props {
  isEnabled?: boolean
  onClose: () => void
  onChanged: () => void
}

type Step = 'qr' | 'verify' | 'backup'

export function TOTPSetupDialog({ onClose, onChanged }: Readonly<Props>) {
  const { t } = useI18n()
  const [methods, setMethods] = useState<MFAMethod[]>([])
  const [showSetup, setShowSetup] = useState(false)
  const [emailSent, setEmailSent] = useState(false)
  const [emailCode, setEmailCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadMethods = () => {
    setLoading(true)
    fetchMFAMethods()
      .then(setMethods)
      .catch(() => setError('Kunne ikke hente MFA-metoder'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadMethods() }, [])

  const handleDelete = async (method: MFAMethod) => {
    if (method.is_active && methods.filter(item => item.is_active).length <= 1) return
    try {
      await deleteMFAMethod(method.id)
      toast.success('MFA-metoden blev slettet')
      loadMethods()
      onChanged()
    } catch {
      toast.error('MFA-metoden kunne ikke slettes')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-[#2d3148]">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-brand-600 dark:text-brand-400" />
            <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100">MFA-metoder</h2>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148]"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          {loading ? <div className="flex justify-center py-6"><Loader2 size={28} className="animate-spin text-brand-500" /></div> : (
            <>
              {methods.length === 0 && <p className="text-sm text-zinc-600 dark:text-slate-400">Der er ikke tilknyttet en MFA-metode endnu.</p>}
              <div className="space-y-2">
                {methods.map(method => {
                  const activeCount = methods.filter(item => item.is_active).length
                  const canDelete = !method.is_active || activeCount > 1
                  return (
                    <div key={method.id} className="flex items-center justify-between rounded-lg border border-zinc-200 dark:border-[#2d3148] px-3 py-2">
                      <div>
                        <p className="text-sm font-medium text-zinc-900 dark:text-slate-100">{method.label || (method.method_type === 'totp' ? 'Authenticator' : 'E-mail')}</p>
                        <p className="text-xs text-zinc-500 dark:text-slate-400">
                          {method.method_type === 'totp' ? 'Authenticator-app' : method.email_address}
                          {' · '}{method.is_active ? 'Aktiv' : 'Inaktiv'}
                        </p>
                        {method.last_used_at && <p className="text-[11px] text-zinc-500">Sidst brugt: {new Date(method.last_used_at).toLocaleString()}</p>}
                      </div>
                      <button type="button" disabled={!canDelete} onClick={() => void handleDelete(method)} title={canDelete ? 'Slet metode' : 'Sidste aktive MFA-metode kan ikke slettes'} className="p-2 text-zinc-400 hover:text-red-500 disabled:opacity-30"><Trash2 size={15} /></button>
                    </div>
                  )
                })}
              </div>
              <div className="space-y-2">
                {!emailSent ? (
                  <button type="button" onClick={() => { void requestEmailMFA().then(() => setEmailSent(true)).catch(() => toast.error('E-mailkode kunne ikke sendes')) }} className="w-full py-2 rounded-lg border text-sm">
                    Tilføj e-mail som MFA
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <input value={emailCode} onChange={event => setEmailCode(event.target.value.replace(/D/g, '').slice(0, 6))} placeholder="E-mailkode" className="flex-1 rounded-lg border px-3 py-2 text-sm dark:bg-[#0f1117]" />
                    <button type="button" onClick={() => { void confirmEmailMFA(emailCode).then(() => { setEmailSent(false); setEmailCode(''); loadMethods(); onChanged() }).catch(() => toast.error('Ugyldig eller udløbet e-mailkode')) }} className="rounded-lg bg-brand-600 px-3 py-2 text-sm text-white">Bekræft</button>
                  </div>
                )}
              </div>
              {!showSetup ? (
                <button type="button" onClick={() => setShowSetup(true)} className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium">
                  <Plus size={15} /> Tilføj authenticator
                </button>
              ) : (
                <SetupFlow
                  onCancel={() => setShowSetup(false)}
                  onDone={() => { setShowSetup(false); loadMethods(); onChanged() }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SetupFlow({ onCancel, onDone }: Readonly<{ onCancel: () => void; onDone: () => void }>) {
  const { t } = useI18n()
  const [step, setStep] = useState<Step>('qr')
  const [secret, setSecret] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copiedCode, setCopiedCode] = useState(false)
  const [copiedSecret, setCopiedSecret] = useState(false)

  useEffect(() => {
    fetchTOTPSetup()
      .then(async data => {
        setSecret(data.secret)
        setQrDataUrl(await QRCode.toDataURL(data.provisioning_uri, { width: 200, margin: 2 }))
      })
      .catch(() => setError(t('totp.loadFailed')))
      .finally(() => setLoading(false))
  }, [t])

  const handleVerify = async (value = code) => {
    if (value.length !== 6) return
    setLoading(true)
    setError(null)
    try {
      const res = await confirmTOTPSetup(value, label.trim() || undefined)
      setBackupCodes(res.backup_codes)
      setStep('backup')
    } catch {
      setError(t('totp.invalidCode'))
      setCode('')
    } finally {
      setLoading(false)
    }
  }

  if (step === 'backup') {
    return <div className="space-y-3">
      <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">{t('totp.saveBackupCodes')}</div>
      <div className="grid grid-cols-2 gap-1.5">{backupCodes.map(c => <code key={c} className="bg-zinc-50 dark:bg-[#0f1117] border border-zinc-200 dark:border-[#2d3148] rounded px-2 py-1 text-xs text-center">{c}</code>)}</div>
      <div className="flex gap-2">
        <button type="button" onClick={() => { void navigator.clipboard.writeText(backupCodes.join('\n')); setCopiedCode(true) }} className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm">{copiedCode ? <Check size={14} /> : <Copy size={14} />} {t('totp.copyAll')}</button>
        <button type="button" onClick={onDone} className="flex-1 py-2 rounded-lg bg-brand-600 text-white text-sm">{t('totp.done2faActive')}</button>
      </div>
    </div>
  }

  return <div className="space-y-3">
    <p className="text-sm text-zinc-600 dark:text-slate-400">{step === 'qr' ? t('totp.scanQr') : t('totp.confirmStep')}</p>
    {error && <div className="text-sm text-red-600 dark:text-red-400 flex items-center gap-2"><AlertTriangle size={14} />{error}</div>}
    {step === 'qr' && loading && <div className="flex justify-center py-4"><Loader2 size={25} className="animate-spin text-brand-500" /></div>}
    {step === 'qr' && !loading && qrDataUrl && <><div className="flex justify-center"><img src={qrDataUrl} alt={t('totp.qrAlt')} width={200} height={200} /></div><input value={label} onChange={event => setLabel(event.target.value)} placeholder="Navn på enhed, f.eks. Telefon" className="w-full rounded-lg border px-3 py-2 text-sm dark:bg-[#0f1117]" /><div className="flex items-center gap-2 text-xs"><code className="flex-1 break-all">{secret}</code><button type="button" onClick={() => { void navigator.clipboard.writeText(secret); setCopiedSecret(true) }}>{copiedSecret ? <Check size={14} /> : <Copy size={14} />}</button></div><button type="button" onClick={() => setStep('verify')} className="w-full py-2 rounded-lg bg-brand-600 text-white text-sm">{t('totp.nextStep')}</button></>}
    {step === 'verify' && <><input type="text" inputMode="numeric" maxLength={6} autoFocus value={code} onChange={event => { const value = event.target.value.replace(/\D/g, '').slice(0, 6); setCode(value); if (value.length === 6) void handleVerify(value) }} className="w-full rounded-lg border px-3 py-2 text-center text-2xl tracking-widest dark:bg-[#0f1117]" placeholder="000000" /><div className="flex gap-2"><button type="button" onClick={onCancel} className="flex-1 py-2 rounded-lg border text-sm">{t('totp.back')}</button><button type="button" disabled={code.length !== 6 || loading} onClick={() => void handleVerify()} className="flex-1 py-2 rounded-lg bg-brand-600 text-white text-sm">{loading ? t('totp.confirming') : t('totp.confirm')}</button></div></>}
  </div>
}
