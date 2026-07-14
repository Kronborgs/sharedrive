import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { prepareDownload } from '@/lib/api'
import { Copy, Check, Download, X } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'

interface DownloadDialogProps {
  ids: string[]
  onClose: () => void
}

type Step = 'configure' | 'ready' | 'downloading'

export function DownloadDialog({ ids, onClose }: Readonly<DownloadDialogProps>) {
  const { t } = useI18n()
  const [usePassword, setUsePassword] = useState(true)
  const [passwordMode, setPasswordMode] = useState<'generate' | 'custom'>('generate')
  const [customPassword, setCustomPassword] = useState('')
  const [step, setStep] = useState<Step>('configure')
  const [generatedPassword, setGeneratedPassword] = useState<string | undefined>()
  const [downloadToken, setDownloadToken] = useState('')
  const [copied, setCopied] = useState(false)

  const prepare = useMutation({
    mutationFn: () => prepareDownload({
      ids,
      use_password: usePassword,
      custom_password: usePassword && passwordMode === 'custom' ? customPassword : undefined,
    }),
    onSuccess: res => {
      setDownloadToken(res.token)
      setGeneratedPassword(res.password)
      setStep('ready')
    },
    onError: () => toast.error(t('download.prepareFailed')),
  })

  const handleCopy = () => {
    if (generatedPassword) {
      void navigator.clipboard.writeText(generatedPassword)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleDownload = () => {
    window.location.href = `/api/v1/files/download-zip?token=${downloadToken}`
    setStep('downloading')
  }

  // Auto-close 3 s after download starts
  useEffect(() => {
    if (step !== 'downloading') return
    const t = setTimeout(onClose, 3000)
    return () => clearTimeout(t)
  }, [step, onClose])

  const canContinue = !prepare.isPending && !(usePassword && passwordMode === 'custom' && customPassword.length < 4)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl shadow-2xl w-full max-w-sm p-5 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">
            Download {ids.length} {ids.length !== 1 ? t('download.items') : t('download.item')}
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-[#2d3148] text-zinc-400">
            <X size={14} />
          </button>
        </div>

        {step === 'configure' ? (
          <>
            {/* Password toggle */}
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={usePassword}
                onChange={e => setUsePassword(e.target.checked)}
                className="w-4 h-4 rounded border-zinc-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="text-sm text-zinc-700 dark:text-slate-300">{t('download.protectZip')}</span>
            </label>

            {usePassword && (
              <div className="space-y-3 pl-7">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={passwordMode === 'generate'}
                    onChange={() => setPasswordMode('generate')}
                    className="text-brand-600"
                  />
                  <span className="text-sm text-zinc-700 dark:text-slate-300">{t('download.generatePwd')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={passwordMode === 'custom'}
                    onChange={() => setPasswordMode('custom')}
                    className="text-brand-600"
                  />
                  <span className="text-sm text-zinc-700 dark:text-slate-300">{t('download.useCustomPwd')}</span>
                </label>
                {passwordMode === 'custom' && (
                  <input
                    type="password"
                    placeholder={t('download.minChars')}
                    value={customPassword}
                    onChange={e => setCustomPassword(e.target.value)}
                    className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-muted"
              >
                {t('download.cancel')}
              </button>
              <button
                onClick={() => prepare.mutate()}
                disabled={!canContinue}
                className="px-4 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium disabled:opacity-50"
              >
                {prepare.isPending ? t('download.preparing') : t('download.continue')}
              </button>
            </div>
          </>
        ) : step === 'ready' ? (
          <>
            {/* Step 2: show password and download button */}
            {generatedPassword && (
              <div className="space-y-1">
                <p className="text-xs text-muted">{t('download.saveZipPwd')}</p>
                <div className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-2">
                  <code className="flex-1 text-sm font-mono text-zinc-900 dark:text-slate-100 select-all break-all">
                    {generatedPassword}
                  </code>
                  <button
                    onClick={handleCopy}
                    className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-[#2d3148] text-zinc-500 shrink-0"
                    title={t('download.copyPwd')}
                  >
                    {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                  </button>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-muted"
              >
                {t('download.cancel')}
              </button>
              <button
                onClick={handleDownload}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium"
              >
                <Download size={14} />
                {t('download.downloadNow')}
              </button>
            </div>
          </>
        ) : (
          /* Step 3: download triggered */
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <Check size={20} className="text-green-600 dark:text-green-400" />
            </div>
            <p className="text-sm font-medium text-zinc-900 dark:text-slate-100">{t('download.started')}</p>
            <p className="text-xs text-muted">{t('download.browserPrompt')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
