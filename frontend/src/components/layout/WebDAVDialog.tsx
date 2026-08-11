import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import type { AppPassword, CreatedAppPassword } from '@/types/api'
import { X, Copy, Check, Trash2, Plus, HardDrive, Monitor, Apple, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { formatDate } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'

interface Props {
  onClose: () => void
}

type Tab = 'windows' | 'macos' | 'linux'

function trimTrailingSlashes(input: string): string {
  let out = input
  while (out.endsWith('/')) out = out.slice(0, -1)
  return out
}

function CopyButton({ text, copyKey, copied, onCopy }: Readonly<{ text: string; copyKey: string; copied: string | null; onCopy: (t: string, k: string) => void }>) {
  const { t } = useI18n()
  return (
    <button type="button"
      onClick={() => onCopy(text, copyKey)}
      className="shrink-0 p-1 rounded text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
      title={t('webdav.copy')}
    >
      {copied === copyKey ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

function CodeRow({ label, value, copyKey, copied, onCopy }: Readonly<{ label: string; value: string; copyKey: string; copied: string | null; onCopy: (t: string, k: string) => void }>) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium text-zinc-500 dark:text-slate-500">{label}</p>
      <div className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-2">
        <span className="flex-1 text-xs font-mono text-zinc-900 dark:text-slate-100 break-all select-all">{value}</span>
        <CopyButton text={value} copyKey={copyKey} copied={copied} onCopy={onCopy} />
      </div>
    </div>
  )
}

export function WebDAVDialog({ onClose }: Props) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const { t } = useI18n()
  const [newName, setNewName] = useState('')
  const [revealed, setRevealed] = useState<CreatedAppPassword | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('windows')
  const [showPSFallback, setShowPSFallback] = useState(false)

  const { data: settings } = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: ({ signal }) => api.get<{ direct_upload_url?: string }>('/api/v1/system/settings', signal),
    staleTime: 5 * 60 * 1000,
  })

  const davBase = settings?.direct_upload_url?.trim()
    ? trimTrailingSlashes(settings.direct_upload_url.trim())
    : window.location.origin
  const davUrl = `${davBase}/dav/${user?.id ?? ''}`
  const macDavUrl = (() => {
    if (davUrl.startsWith('https://')) return davUrl.replace(/^https:\/\//, 'davs://')
    if (davUrl.startsWith('http://')) return davUrl.replace(/^http:\/\//, 'dav://')
    return davUrl
  })()

  // Windows UNC path: \\hostname@SSL@443\dav\userid
  const hostname = (() => { try { return new URL(davBase).hostname } catch { return davBase.replace(/^https?:\/\//, '') } })()
  const windowsUnc = `\\\\${hostname}@SSL@443\\dav\\${user?.id ?? ''}`

  // Linux davfs2 mount
  const linuxMountPoint = '/home/din-bruger/WebDAV/sharedrive'
  const linuxMount = `sudo mount -t davfs ${davUrl} ${linuxMountPoint}`
  const linuxFstab = `${davUrl} ${linuxMountPoint} davfs rw,user,_netdev,noauto,x-systemd.automount,uid=1000,gid=1000,file_mode=0664,dir_mode=0775 0 0`
  const linuxSecrets = `${davUrl}  ${user?.email ?? 'din@email.dk'}  DIT-APP-PASSWORD`
  const linuxPerms = `sudo chmod 600 /etc/davfs2/secrets`
  const linuxMkdir = `mkdir -p ~/WebDAV/sharedrive`
  const linuxMountTest = `sudo mount -a`
  const linuxUidCmd = `id -u`
  const linuxGidCmd = `id -g`
  const macAutoScript = `cat > ~/mount-sharedrive-webdav.sh <<'EOF'\n#!/bin/zsh\nosascript -e 'tell application "Finder" to mount volume "${macDavUrl}"'\nEOF\nchmod +x ~/mount-sharedrive-webdav.sh`
  const windowsRegCmd = String.raw`Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\WebClient\Parameters" -Name FileSizeLimitInBytes -Value 0xFFFFFFFF; net stop webclient; net start webclient`

  const { data: passwords } = useQuery({
    queryKey: ['app-passwords'],
    queryFn: ({ signal }) => api.get<AppPassword[]>('/api/v1/me/app-passwords', signal),
  })

  const create = useMutation({
    mutationFn: (name: string) =>
      api.post<CreatedAppPassword>('/api/v1/me/app-passwords', { name, scope: 'webdav' }),
    onSuccess: (data) => {
      ignorePromise(qc.invalidateQueries({ queryKey: ['app-passwords'] }))
      setRevealed(data)
      setNewName('')
    },
    onError: () => toast.error(t('webdav.createFailed')),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/me/app-passwords/${id}`),
    onSuccess: () => ignorePromise(qc.invalidateQueries({ queryKey: ['app-passwords'] })),
    onError: () => toast.error(t('webdav.revokeFailed')),
  })

  const copy = (text: string, key: string) => {
    ignorePromise(navigator.clipboard.writeText(text))
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'windows',  label: 'Windows', icon: <Monitor size={13} /> },
    { id: 'macos',    label: 'macOS',   icon: <Apple size={13} /> },
    { id: 'linux',    label: 'Linux',   icon: <Terminal size={13} /> },
  ]

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-[#2d3148]">
          <div className="flex items-center gap-2">
            <HardDrive size={16} className="text-brand-500" />
            <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100">{t('webdav.title')}</h2>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-5 overflow-y-auto flex-1">

          {/* Platform tabs */}
          <div className="flex gap-1 rounded-lg bg-zinc-100 dark:bg-[#0f1117] p-1">
            {tabs.map(t => (
              <button type="button"
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  tab === t.id
                    ? 'bg-white dark:bg-[#1a1d27] text-zinc-900 dark:text-slate-100 shadow-sm'
                    : 'text-zinc-500 dark:text-slate-400 hover:text-zinc-700 dark:hover:text-slate-300'
                }`}
              >
                {t.icon}{t.label}
              </button>
            ))}
          </div>

          {/* ── Windows ── */}
          {tab === 'windows' && (
            <div className="space-y-3">
              {/* Primary: GUI method */}
              <CodeRow
                label={t('webdav.windowsNetPath')}
                value={windowsUnc}
                copyKey="winunc"
                copied={copied}
                onCopy={copy}
              />

              <ol className="text-[11px] text-zinc-600 dark:text-slate-400 space-y-1.5 list-decimal list-inside">
                <li>Åbn Stifinder (<kbd className="font-mono text-[10px] bg-zinc-100 dark:bg-[#0f1117] px-1 py-0.5 rounded">Win+E</kbd>)</li>
                <li>Højreklik på <strong>Denne computer</strong> → klik <strong>Tilknyt netværksdrev…</strong></li>
                <li>Vælg et drevbogstav (f.eks. <strong>S:</strong>)</li>
                <li>Indsæt stien ovenfor i feltet <strong>Mappe:</strong></li>
                <li>Sæt flueben ved <strong>Genetablér forbindelsen ved logon</strong></li>
                <li>Sæt flueben ved <strong>Opret forbindelsen som en anden bruger</strong></li>
                <li>Log ind med din <strong>email</strong> og et <strong>app password</strong> oprettet nedenfor</li>
              </ol>

              <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3 space-y-2">
                <p className="text-[11px] font-semibold text-blue-800 dark:text-blue-300">{t('webdav.raiseLimitTitle')}</p>
                <p className="text-[11px] text-blue-700 dark:text-blue-400">{t('webdav.raiseLimitDesc')}</p>
                <div className="flex items-start gap-2 rounded border border-blue-200 dark:border-blue-700 bg-white dark:bg-[#0f1117] px-3 py-2">
                  <code className="flex-1 text-[10px] font-mono text-zinc-800 dark:text-slate-200 break-all select-all">{windowsRegCmd}</code>
                  <CopyButton text={windowsRegCmd} copyKey="winreg" copied={copied} onCopy={copy} />
                </div>
              </div>

              {/* Fallback: PowerShell */}
              <div className="rounded-lg border border-zinc-200 dark:border-[#2d3148]">
                <button type="button"
                  onClick={() => setShowPSFallback(v => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-medium text-zinc-600 dark:text-slate-400 hover:text-zinc-900 dark:hover:text-slate-200 transition-colors"
                >
                  <span>{t('webdav.altPowershell')}</span>
                  <span className="text-[10px]">{showPSFallback ? '▲' : '▼'}</span>
                </button>
                {showPSFallback && (
                  <div className="px-3 pb-3 space-y-2 border-t border-zinc-200 dark:border-[#2d3148] pt-2">
                    <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-2">
                      <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-300 mb-0.5">{t('webdav.psWarningTitle')}</p>
                      <p className="text-[11px] text-amber-700 dark:text-amber-400">Åbn Start → søg "PowerShell" → klik direkte. Kør <strong>ikke</strong> som administrator, ellers vises drevet ikke i Stifinder.</p>
                    </div>
                    <CodeRow
                      label={t('webdav.psCmdLabel')}
                      value={`net use S: "${windowsUnc}" /user:${user?.email ?? 'din@email.dk'} APP-PASSWORD /persistent:yes`}
                      copyKey="wincmd"
                      copied={copied}
                      onCopy={copy}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── macOS ── */}
          {tab === 'macos' && (
            <div className="space-y-3">
              <CodeRow label="URL" value={macDavUrl} copyKey="macurl" copied={copied} onCopy={copy} />
              <ol className="text-[11px] text-zinc-600 dark:text-slate-400 space-y-1 list-decimal list-inside">
                <li>Finder → <strong>Gå</strong> → <strong>Opret forbindelse til server…</strong> (⌘K)</li>
                <li>Indsæt URL'en ovenfor og klik <strong>Opret forbindelse</strong></li>
                <li>Log ind med din <strong>email</strong> og en <strong>app password</strong> nedenfor</li>
              </ol>

              <div className="rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] p-3 space-y-2">
                <p className="text-[11px] font-semibold text-zinc-700 dark:text-slate-300">{t('webdav.macAutoTitle')}</p>
                <ol className="text-[11px] text-zinc-600 dark:text-slate-400 space-y-1 list-decimal list-inside">
                  <li>{t('webdav.macAutoStep1')}</li>
                  <li>{t('webdav.macAutoStep2')}</li>
                  <li>{t('webdav.macAutoStep3')}</li>
                </ol>
                <CodeRow label={t('webdav.macAutoCmdLabel')} value={macAutoScript} copyKey="macauto" copied={copied} onCopy={copy} />
              </div>
            </div>
          )}

          {/* ── Linux ── */}
          {tab === 'linux' && (
            <div className="space-y-3">
              <CodeRow label="WebDAV URL" value={davUrl} copyKey="linurl" copied={copied} onCopy={copy} />
              <p className="text-[11px] text-zinc-500 dark:text-slate-500">Installer <code className="font-mono">davfs2</code> og mount engangsmount:</p>
              <CodeRow label={t('webdav.linMountLabel')} value={linuxMount} copyKey="linmnt" copied={copied} onCopy={copy} />
              <CodeRow label={t('webdav.linMkdirLabel')} value={linuxMkdir} copyKey="linmkdir" copied={copied} onCopy={copy} />
              <p className="text-[11px] text-zinc-500 dark:text-slate-500">Eller tilføj til <code className="font-mono">/etc/fstab</code> for automatisk mount ved boot:</p>
              <CodeRow label="/etc/fstab entry" value={linuxFstab} copyKey="linfstab" copied={copied} onCopy={copy} />
              <p className="text-[11px] text-zinc-500 dark:text-slate-500">{t('webdav.linSecretsWhere')}</p>
              <CodeRow label="/etc/davfs2/secrets" value={linuxSecrets} copyKey="linsec" copied={copied} onCopy={copy} />
              <CodeRow label={t('webdav.linPermsLabel')} value={linuxPerms} copyKey="linperm" copied={copied} onCopy={copy} />
              <p className="text-[11px] text-zinc-500 dark:text-slate-500">{t('webdav.linUidGidHelp')}</p>
              <CodeRow label={t('webdav.linUidCmdLabel')} value={linuxUidCmd} copyKey="linuid" copied={copied} onCopy={copy} />
              <CodeRow label={t('webdav.linGidCmdLabel')} value={linuxGidCmd} copyKey="lingid" copied={copied} onCopy={copy} />
              <CodeRow label={t('webdav.linMountTestLabel')} value={linuxMountTest} copyKey="lintest" copied={copied} onCopy={copy} />
            </div>
          )}

          {/* Revealed new password — show once */}
          {revealed && (
            <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2">
              <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                {t('webdav.copyPasswordNow')}
              </p>
              <div className="flex items-center gap-2 rounded border border-amber-200 dark:border-amber-700 bg-white dark:bg-[#0f1117] px-3 py-1.5">
                <span className="flex-1 text-sm font-mono text-zinc-900 dark:text-slate-100 break-all">{revealed.password}</span>
                <CopyButton text={revealed.password} copyKey="pwd" copied={copied} onCopy={copy} />
              </div>
              <button type="button"
                onClick={() => setRevealed(null)}
                className="text-[11px] text-amber-700 dark:text-amber-400 hover:underline"
              >
                {t('webdav.savedClose')}
              </button>
            </div>
          )}

          {/* Create new app password */}
          <div className="rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 p-3 space-y-1">
            <p className="text-xs font-semibold text-emerald-800 dark:text-emerald-300">{t('webdav.noExpiryTitle')}</p>
            <p className="text-[11px] text-emerald-700 dark:text-emerald-400">{t('webdav.noExpiryDesc')}</p>
          </div>

          {/* Create new app password */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('webdav.createAppPwd')}</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder={t('webdav.namePlaceholder')}
                className="flex-1 rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) create.mutate(newName.trim()) }}
              />
              <button type="button"
                onClick={() => { if (newName.trim()) create.mutate(newName.trim()) }}
                disabled={!newName.trim() || create.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                <Plus size={14} />
                {t('webdav.create')}
              </button>
            </div>
          </div>

          {/* Existing app passwords */}
          {passwords && passwords.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('webdav.activePasswords')}</p>
              <ul className="space-y-1">
                {passwords.map(p => (
                  <li key={p.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-50 dark:bg-[#0f1117]">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-900 dark:text-slate-100 truncate">{p.name}</p>
                      <p className="text-[11px] text-muted">
                        {p.last_used_at ? t('webdav.lastUsedOn', { when: formatDate(p.last_used_at) }) : t('webdav.neverUsed')}
                        {' · '}{t('webdav.createdOn', { when: formatDate(p.created_at) })}
                      </p>
                    </div>
                    <button type="button"
                      onClick={() => revoke.mutate(p.id)}
                      className="p-1 rounded text-zinc-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                      title={t('webdav.revoke')}
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
