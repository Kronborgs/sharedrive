import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import type { FileItem, Share, SharePermissions, Group, AppPassword, CreatedAppPassword } from '@/types/api'
import { formatDate } from '@/lib/utils'
import { X, Check, Link, Trash2, UserPlus, ChevronDown, ChevronUp, Copy, HardDrive, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'

interface ShareDialogProps {
  item: FileItem
  onClose: () => void
}

type ShareTargetType = 'user' | 'group' | 'link' | 'webdav'

const DEFAULT_PERMS: SharePermissions = {
  can_view: true,
  can_upload: false,
  can_edit: false,
  can_delete: false,
  can_reshare: false,
  is_owner: false,
}

// Return tomorrow at noon as a datetime-local string (YYYY-MM-DDTHH:mm)
function defaultExpiry(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(12, 0, 0, 0)
  return d.toISOString().slice(0, 16)
}

const PERM_KEYS = (Object.keys(DEFAULT_PERMS).filter(k => k !== 'is_owner') as (keyof SharePermissions)[])

function trimTrailingSlashes(input: string): string {
  let out = input
  while (out.endsWith('/')) out = out.slice(0, -1)
  return out
}

type ShareTabLabelKey = 'share.tabLink' | 'share.tabGroup' | 'share.tabWebdav' | 'share.tabUser'

function getShareTabLabel(tabType: ShareTargetType, t: (key: ShareTabLabelKey) => string): string {
  switch (tabType) {
    case 'link':
      return t('share.tabLink')
    case 'group':
      return t('share.tabGroup')
    case 'webdav':
      return t('share.tabWebdav')
    default:
      return t('share.tabUser')
  }
}

function resolveDavBase(directUploadUrl?: string): string {
  const trimmed = directUploadUrl?.trim()
  if (!trimmed) return window.location.origin
  return trimTrailingSlashes(trimmed)
}

function buildEncodedFolderPath(breadcrumbs?: Array<{ id: string; name: string }>): string {
  if (!breadcrumbs?.length) return ''
  return `${breadcrumbs.map(b => encodeURIComponent(b.name)).join('/')}/`
}

function isCreateShareDisabled(params: {
  isPending: boolean
  tab: ShareTargetType
  email: string
  groupId: string
}): boolean {
  if (params.isPending) return true
  if (params.tab === 'user') return !params.email
  if (params.tab === 'group') return !params.groupId
  return false
}

function buildShareCreateBody(params: {
  itemId: string
  perms: SharePermissions
  hasExpiry: boolean
  expiry: string
  tab: ShareTargetType
  email: string
  groupId: string
}): Record<string, unknown> {
  const expiresAt = params.hasExpiry && params.expiry
    ? new Date(params.expiry).toISOString()
    : null

  const body: Record<string, unknown> = {
    resource_id: params.itemId,
    can_view: params.perms.can_view,
    can_upload: params.perms.can_upload,
    can_edit: params.perms.can_edit,
    can_delete: params.perms.can_delete,
    can_reshare: params.perms.can_reshare,
    expires_at: expiresAt,
  }

  switch (params.tab) {
    case 'user':
      body.grantee_type = 'user'
      body.grantee_email = params.email
      break
    case 'group':
      body.grantee_type = 'group'
      body.grantee_id = params.groupId
      break
    default:
      body.grantee_type = 'link'
      break
  }

  return body
}

function PermCheckboxes({
  perms,
  onChange,
  isFolder = true,
}: {
  perms: SharePermissions
  onChange: (p: SharePermissions) => void
  isFolder?: boolean
}) {
  const { t } = useI18n()
  const permLabels: Partial<Record<string, string>> = {
    can_view: t('share.permView'),
    can_upload: t('share.permUpload'),
    can_edit: t('share.permEdit'),
    can_delete: t('share.permDelete'),
    can_reshare: t('share.permReshare'),
  }
  const keys = isFolder ? PERM_KEYS : PERM_KEYS.filter(k => k !== 'can_upload')
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {keys.map(key => (
        <label key={key} className="flex items-center gap-1.5 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={perms[key] as boolean}
            onChange={e => onChange({ ...perms, [key]: e.target.checked })}
            className="rounded border-zinc-300 dark:border-[#4d5678] text-brand-600"
          />
          <span className="text-xs text-zinc-700 dark:text-slate-300 capitalize">
            {permLabels[key] ?? key.replace('can_', '')}
          </span>
        </label>
      ))}
    </div>
  )
}

function ActiveShareRow({
  s,
  onRevoke,
  onCopyLink,
  copied,
  onUpdate,
  isFolder = true,
}: {
  s: Share
  onRevoke: () => void
  onCopyLink?: () => void
  copied: boolean
  onUpdate: (perms: SharePermissions, expiresAt: string | null) => void
  isFolder?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const { t } = useI18n()
  const [editPerms, setEditPerms] = useState<SharePermissions>({
    can_view: s.can_view,
    can_upload: s.can_upload,
    can_edit: s.can_edit,
    can_delete: s.can_delete,
    can_reshare: s.can_reshare,
    is_owner: false,
  })
  const [editExpiry, setEditExpiry] = useState<string>(
    s.expires_at ? new Date(s.expires_at).toISOString().slice(0, 16) : ''
  )
  const [hasExpiry, setHasExpiry] = useState(!!s.expires_at)

  const displayName =
    s.grantee_type === 'link'
      ? t('share.publicLink')
      : s.grantee_email ?? s.pending_email ?? s.grantee_group_name ?? 'Unknown'

  return (
    <li className="rounded-lg bg-zinc-50 dark:bg-[#0f1117] overflow-hidden">
      {/* Summary row */}
      <div className="flex items-center gap-2 p-2">
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex-1 min-w-0 text-left"
        >
          <p className="text-xs font-medium text-zinc-900 dark:text-slate-100 truncate">{displayName}</p>
          {s.expires_at && (
            <p className="text-[10px] text-muted">{t('share.expiresAt', { when: formatDate(s.expires_at) })}</p>
          )}
        </button>
        <button
          onClick={() => setExpanded(v => !v)}
          className="p-1 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-slate-300 transition-colors"
          title={expanded ? t('share.collapse') : t('share.editPermissions')}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {s.grantee_type === 'link' && onCopyLink && (
          <button
            onClick={onCopyLink}
            className="p-1 rounded text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
            title={t('share.copyLink')}
          >
            {copied ? <Check size={13} /> : <Link size={13} />}
          </button>
        )}
        <button
          onClick={onRevoke}
          className="p-1 rounded text-zinc-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
          title={t('share.revoke')}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Expanded edit panel */}
      {expanded && (
        <div className="border-t border-zinc-200 dark:border-[#2d3148] px-3 pb-3 pt-2 space-y-3">
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-zinc-500 dark:text-slate-400">{t('share.permissions')}</p>
            <PermCheckboxes perms={editPerms} onChange={setEditPerms} isFolder={isFolder} />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-medium text-zinc-500 dark:text-slate-400">{t('share.expiry')}</p>
              <button
                type="button"
                onClick={() => setHasExpiry(v => !v)}
                className="text-[11px] text-brand-600 dark:text-brand-400 hover:underline"
              >
                {hasExpiry ? t('share.removeExpiry') : t('share.setExpiry')}
              </button>
            </div>
            {hasExpiry ? (
              <input
                type="datetime-local"
                value={editExpiry}
                onChange={e => setEditExpiry(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] px-3 py-1.5 text-xs text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            ) : (
              <p className="text-xs text-muted">{t('share.neverExpires')}</p>
            )}
          </div>
          <button
            onClick={() => {
              const expiresAt = hasExpiry && editExpiry ? new Date(editExpiry).toISOString() : null
              onUpdate(editPerms, expiresAt)
              setExpanded(false)
            }}
            className="w-full py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium transition-colors"
          >
            {t('share.saveChanges')}
          </button>
        </div>
      )}
    </li>
  )
}

export function ShareDialog({ item, onClose }: ShareDialogProps) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const { t } = useI18n()
  const [tab, setTab] = useState<ShareTargetType>('user')
  const [email, setEmail] = useState('')
  const [groupId, setGroupId] = useState('')
  const [perms, setPerms] = useState<SharePermissions>(DEFAULT_PERMS)
  const [hasExpiry, setHasExpiry] = useState(false)
  const [expiry, setExpiry] = useState(defaultExpiry())
  const [copied, setCopied] = useState(false)
  const [davCopied, setDavCopied] = useState<string | null>(null)
  const [davPwdName, setDavPwdName] = useState('')
  const [davRevealed, setDavRevealed] = useState<CreatedAppPassword | null>(null)

  const { data: systemSettings } = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: ({ signal }) => api.get<{ direct_upload_url?: string }>('/api/v1/system/settings', signal),
    staleTime: 5 * 60 * 1000,
  })

  const davBase = resolveDavBase(systemSettings?.direct_upload_url)

  // Fetch breadcrumbs for the file's parent folder to build the full WebDAV path
  const { data: breadcrumbs } = useQuery({
    queryKey: ['breadcrumbs', item.parent_id],
    queryFn: ({ signal }) =>
      api.get<Array<{ id: string; name: string }>>(`/api/v1/files/breadcrumbs?folder_id=${item.parent_id}`, signal),
    enabled: tab === 'webdav' && item.parent_id != null,
  })

  const davOwnerID = item.owner_id
  const folderPath = buildEncodedFolderPath(breadcrumbs)
  const davFileUrl = `${davBase}/dav/${davOwnerID}/${folderPath}${encodeURIComponent(item.name)}`

  const copyDav = (text: string, key: string) => {
    ignorePromise(navigator.clipboard.writeText(text))
    setDavCopied(key)
    setTimeout(() => setDavCopied(null), 2000)
  }

  const { data: shares } = useQuery({
    queryKey: ['shares', item.id],
    queryFn: ({ signal }) => api.get<Share[]>(`/api/v1/shares?resource_id=${item.id}`, signal),
  })

  const { data: groups } = useQuery({
    queryKey: ['groups'],
    queryFn: ({ signal }) => api.get<Group[]>('/api/v1/groups', signal),
  })

  // App passwords scoped to this specific file/folder
  const { data: scopedPasswords } = useQuery({
    queryKey: ['app-passwords', 'resource', item.id],
    queryFn: ({ signal }) => api.get<AppPassword[]>('/api/v1/me/app-passwords', signal).then(
      list => list.filter(p => p.resource_id === item.id)
    ),
    enabled: tab === 'webdav',
  })

  const davCreatePwd = useMutation({
    mutationFn: (name: string) =>
      api.post<CreatedAppPassword>('/api/v1/me/app-passwords', {
        name,
        scope: 'webdav',
        resource_id: item.id,
      }),
    onSuccess: (data) => {
      ignorePromise(qc.invalidateQueries({ queryKey: ['app-passwords', 'resource', item.id] }))
      setDavRevealed(data)
      setDavPwdName('')
    },
    onError: () => toast.error(t('share.appPwdCreateFailed')),
  })

  const davRevokePwd = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/me/app-passwords/${id}`),
    onSuccess: () => ignorePromise(qc.invalidateQueries({ queryKey: ['app-passwords', 'resource', item.id] })),
    onError: () => toast.error(t('share.appPwdDeleteFailed')),
  })

  const createShare = useMutation({
    mutationFn: (body: object) => api.post<Share>(`/api/v1/shares`, body),
    onSuccess: () => {
      ignorePromise(qc.invalidateQueries({ queryKey: ['shares', item.id] }))
      ignorePromise(qc.invalidateQueries({ queryKey: ['files'] }))
      setEmail('')
      toast.success(t('share.created'))
    },
    onError: (e: Error) => toast.error(e.message || t('share.createFailed')),
  })

  const disableCreateShare = isCreateShareDisabled({
    isPending: createShare.isPending,
    tab,
    email,
    groupId,
  })

  const revokeShare = useMutation({
    mutationFn: (shareId: string) => api.delete(`/api/v1/shares/${shareId}`),
    onSuccess: () => {
      ignorePromise(qc.invalidateQueries({ queryKey: ['shares', item.id] }))
      ignorePromise(qc.invalidateQueries({ queryKey: ['files'] }))
    },
    onError: () => toast.error(t('share.revokeFailed')),
  })

  const updateShare = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) =>
      api.patch(`/api/v1/shares/${id}`, body),
    onSuccess: () => {
      ignorePromise(qc.invalidateQueries({ queryKey: ['shares', item.id] }))
      toast.success(t('share.updated'))
    },
    onError: () => toast.error(t('share.updateFailed')),
  })

  const handleCreate = () => {
    createShare.mutate(buildShareCreateBody({
      itemId: item.id,
      perms,
      hasExpiry,
      expiry,
      tab,
      email,
      groupId,
    }))
  }

  const copyLink = (token: string) => {
    ignorePromise(navigator.clipboard.writeText(`${window.location.origin}/shared/${token}`))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100 dark:border-[#2d3148]">
          <div>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-slate-100">{t('share.title')}</h2>
            <p className="text-xs text-muted truncate max-w-[280px]" title={item.name}>{item.name}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-zinc-100 dark:border-[#2d3148] px-5">
          {(['user', 'group', 'link', 'webdav'] as ShareTargetType[]).map(tabType => (
            <button
              key={tabType}
              onClick={() => setTab(tabType)}
              className={`py-2.5 px-3 text-sm font-medium border-b-2 transition-colors ${
                tab === tabType
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-muted hover:text-zinc-700 dark:hover:text-slate-300'
              }`}
            >
              {getShareTabLabel(tabType, t)}
            </button>
          ))}
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Target input */}
          {tab === 'user' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('share.emailLabel')}</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="user@example.com"
                className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          )}
          {tab === 'group' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('share.groupLabel')}</label>
              <select
                value={groupId}
                onChange={e => setGroupId(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">Select a groupÔÇª</option>
                {groups?.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </div>
          )}
          {tab === 'link' && (
            <p className="text-xs text-muted">
              {t('share.publicLinkDesc')}
            </p>
          )}

          {tab === 'webdav' && (
            <div className="space-y-3">
              <p className="text-xs text-zinc-600 dark:text-slate-400">
                {t('share.davDesc', { type: item.is_folder ? t('share.folder') : t('share.file') })}
              </p>

              {/* File/folder URL */}
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-zinc-500 dark:text-slate-500">
                  {t(item.is_folder ? 'share.folderUrl' : 'share.fileUrl')}
                </p>
                <div className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-2">
                  <span className="flex-1 text-xs font-mono text-zinc-900 dark:text-slate-100 break-all select-all">{davFileUrl}</span>
                  <button
                    onClick={() => copyDav(davFileUrl, 'file')}
                    className="shrink-0 p-1 rounded text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
                    title={t('share.webdavCopyUrl')}
                  >
                    {davCopied === 'file' ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
              </div>

              {/* Username */}
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-zinc-500 dark:text-slate-500">{t('share.username')}</p>
                <div className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-2">
                  <span className="flex-1 text-xs font-mono text-zinc-900 dark:text-slate-100 select-all">{user?.email ?? ''}</span>
                  <button
                    onClick={() => copyDav(user?.email ?? '', 'email')}
                    className="shrink-0 p-1 rounded text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
                    title={t('share.webdavCopyEmail')}
                  >
                    {davCopied === 'email' ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                </div>
              </div>

              {/* Instructions */}
              <div className="rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] p-3 space-y-2">
                <div className="flex items-center gap-1.5">
                  <HardDrive size={12} className="text-zinc-500" />
                  <p className="text-[11px] font-semibold text-zinc-700 dark:text-slate-300">KeePass — Open from URL</p>
                </div>
                <ol className="text-[11px] text-zinc-600 dark:text-slate-400 space-y-1 list-decimal list-inside">
                  <li>KeePass → <strong>File</strong> → <strong>Open</strong> → <strong>Open from URL…</strong></li>
                  <li>Indsæt URL'en ovenfor i feltet <strong>URL</strong></li>
                  <li>Indsæt din email og app password nedenfor som credentials</li>
                  <li>Vælg <strong>Do not remember</strong> (sikrere)</li>
                </ol>
              </div>

              {/* Revealed password — show once */}
              {davRevealed && (
                <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2">
                  <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                    {t('share.copyPwdNow')}
                  </p>
                  <div className="flex items-center gap-2 rounded border border-amber-200 dark:border-amber-700 bg-white dark:bg-[#0f1117] px-3 py-1.5">
                    <span className="flex-1 text-sm font-mono text-zinc-900 dark:text-slate-100 break-all select-all">{davRevealed.password}</span>
                    <button
                      onClick={() => copyDav(davRevealed.password, 'newpwd')}
                      className="shrink-0 p-1 rounded text-zinc-400 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
                    >
                      {davCopied === 'newpwd' ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                  <button
                    onClick={() => setDavRevealed(null)}
                    className="text-[11px] text-amber-700 dark:text-amber-400 hover:underline"
                  >
                    {t('share.savedClose')}
                  </button>
                </div>
              )}

              {/* Create scoped app password */}
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-zinc-600 dark:text-slate-400">
                  {t('share.createPwdFor', { type: item.is_folder ? t('share.folder') : t('share.file') })}
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={davPwdName}
                    onChange={e => setDavPwdName(e.target.value)}
                    placeholder={t('share.webdavNamePlaceholder')}
                    className="flex-1 rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    onKeyDown={e => { if (e.key === 'Enter' && davPwdName.trim()) davCreatePwd.mutate(davPwdName.trim()) }}
                  />
                  <button
                    onClick={() => { if (davPwdName.trim()) davCreatePwd.mutate(davPwdName.trim()) }}
                    disabled={!davPwdName.trim() || davCreatePwd.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
                  >
                    <Plus size={14} />
                    {t('share.create')}
                  </button>
                </div>
              </div>

              {/* Existing scoped passwords */}
              {scopedPasswords && scopedPasswords.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[11px] font-medium text-zinc-500 dark:text-slate-500">{t('share.activePwdsFor', { type: item.is_folder ? t('share.folder') : t('share.file') })}</p>
                  <ul className="space-y-1">
                    {scopedPasswords.map(p => (
                      <li key={p.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-50 dark:bg-[#0f1117]">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-zinc-900 dark:text-slate-100 truncate">{p.name}</p>
                          <p className="text-[11px] text-muted">
                            {p.last_used_at ? t('share.lastUsedOn', { when: formatDate(p.last_used_at) }) : t('share.neverUsed')}
                          </p>
                        </div>
                        <button
                          onClick={() => davRevokePwd.mutate(p.id)}
                          className="p-1 rounded text-zinc-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                          title={t('share.webdavDeleteTitle')}
                        >
                          <Trash2 size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Permissions */}
          {tab !== 'webdav' && <>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('share.permissions')}</p>
            <PermCheckboxes perms={perms} onChange={setPerms} isFolder={item.is_folder} />
          </div>

          {/* Expiry */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('share.expiry')}</label>
              <button
                type="button"
                onClick={() => setHasExpiry(v => !v)}
                className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
              >
                {hasExpiry ? t('share.removeExpiry') : t('share.setExpiry')}
              </button>
            </div>
            {hasExpiry ? (
              <input
                type="datetime-local"
                value={expiry}
                onChange={e => setExpiry(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            ) : (
              <p className="text-xs text-muted">{t('share.neverExpires')}</p>
            )}
          </div>

          <button
            onClick={handleCreate}
            disabled={disableCreateShare}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            <UserPlus size={14} />
            {createShare.isPending ? t('share.sharing') : t('share.title')}
          </button>
          </>}

          {/* Existing shares */}
          {shares && shares.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-zinc-100 dark:border-[#2d3148]">
              <p className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('share.activeShares')}</p>
              <ul className="space-y-1.5">
                {shares.map(s => (
                  <ActiveShareRow
                    key={s.id}
                    s={s}
                    isFolder={item.is_folder}
                    copied={copied}
                    onRevoke={() => revokeShare.mutate(s.id)}
                    onCopyLink={s.grantee_type === 'link' ? () => copyLink(s.token ?? '') : undefined}
                    onUpdate={(editedPerms, expiresAt) =>
                      updateShare.mutate({
                        id: s.id,
                        body: {
                          can_view: editedPerms.can_view,
                          can_upload: editedPerms.can_upload,
                          can_edit: editedPerms.can_edit,
                          can_delete: editedPerms.can_delete,
                          can_reshare: editedPerms.can_reshare,
                          expires_at: expiresAt,
                        },
                      })
                    }
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

