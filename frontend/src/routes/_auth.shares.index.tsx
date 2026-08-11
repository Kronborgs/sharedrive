import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { FileItem, Share, SharePermissions } from '@/types/api'
import { FileList } from '@/components/files/FileViews'
import { FolderPickerDialog } from '@/components/files/FolderPickerDialog'
import { useState } from 'react'
import { PreviewModal } from '@/components/files/PreviewModal'
import { OnlyOfficeEditor } from '@/components/files/OnlyOfficeEditor'
import { TextEditor } from '@/components/files/TextEditor'
import { shouldOpenInOnlyOffice, shouldOpenInTextEditor } from '@/lib/file-types'
import { useI18n } from '@/lib/i18n'
import { formatDate } from '@/lib/utils'
import { ignorePromise } from '@/lib/ignore-promise'
import {
  Clock,
  Folder,
  FolderOpen,
  FolderPlus,
  Link as LinkIcon,
  Mail,
  UserRound,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_auth/shares/')({
  component: SharedPage,
})

interface SharedFileItem {
  id: string
  name: string
  is_folder: boolean
  size_bytes: number
  mime_type: string | null
  created_at: string
}

interface SharedItem {
  share: Share
  item: SharedFileItem
}

interface MyShareEntry {
  id: string
  resource_id: string
  owner_id: string
  grantee_type: 'user' | 'group' | 'link'
  grantee_id?: string
  grantee_email?: string | null
  grantee_display_name?: string | null
  grantee_group_name?: string | null
  pending_email?: string | null
  token?: string | null
  can_view: boolean
  can_upload: boolean
  can_edit: boolean
  can_delete: boolean
  can_reshare: boolean
  expires_at?: string | null
  created_at: string
}

interface MyShareGroup {
  item: SharedFileItem & {
    parent_id?: string | null
    full_path: string
  }
  shares: MyShareEntry[]
}

type PermField = 'can_view' | 'can_upload' | 'can_edit' | 'can_delete' | 'can_reshare'
type TranslateFn = ReturnType<typeof useI18n>['t']
type RecipientKind = 'user' | 'group' | 'link'

interface RecipientShare {
  share: MyShareEntry
  item: MyShareGroup['item']
}

interface RecipientShareGroup {
  key: string
  kind: RecipientKind
  title: string
  subtitle: string
  status: string
  shares: RecipientShare[]
}

const DEFAULT_PERMISSIONS: SharePermissions = {
  can_view: true,
  can_upload: false,
  can_edit: false,
  can_delete: false,
  can_reshare: false,
  is_owner: false,
}

const PERMISSION_META: ReadonlyArray<{
  field: PermField
  labelKey: 'share.permView' | 'share.permUpload' | 'share.permEdit' | 'share.permDelete' | 'share.permReshare'
  activeClassName: string
}> = [
  { field: 'can_view', labelKey: 'share.permView', activeClassName: 'border-zinc-300 text-zinc-700 dark:border-slate-600 dark:text-slate-200' },
  { field: 'can_upload', labelKey: 'share.permUpload', activeClassName: 'border-blue-200 text-blue-600 dark:border-blue-500/30 dark:text-blue-300' },
  { field: 'can_edit', labelKey: 'share.permEdit', activeClassName: 'border-emerald-200 text-emerald-600 dark:border-emerald-500/30 dark:text-emerald-300' },
  { field: 'can_delete', labelKey: 'share.permDelete', activeClassName: 'border-red-200 text-red-600 dark:border-red-500/30 dark:text-red-300' },
  { field: 'can_reshare', labelKey: 'share.permReshare', activeClassName: 'border-violet-200 text-violet-600 dark:border-violet-500/30 dark:text-violet-300' },
]

function getPermissionFields(isFolder: boolean): ReadonlyArray<PermField> {
  return isFolder
    ? ['can_view', 'can_upload', 'can_edit', 'can_delete', 'can_reshare']
    : ['can_view', 'can_edit', 'can_delete', 'can_reshare']
}

function mapSharePermissions(share: MyShareEntry): SharePermissions {
  return {
    can_view: share.can_view,
    can_upload: share.can_upload,
    can_edit: share.can_edit,
    can_delete: share.can_delete,
    can_reshare: share.can_reshare,
    is_owner: false,
  }
}

function getRecipientKey(share: MyShareEntry): string {
  switch (share.grantee_type) {
    case 'group':
      return `group:${share.grantee_id ?? share.grantee_group_name ?? share.id}`
    case 'link':
      return `link:${share.id}`
    default:
      return `user:${share.grantee_id ?? share.grantee_email ?? share.pending_email ?? share.id}`
  }
}

function getRecipientTitle(share: MyShareEntry, t: TranslateFn): string {
  if (share.grantee_type === 'group') return share.grantee_group_name ?? t('shared.groupStatus')
  if (share.grantee_type === 'link') return t('shared.publicLink')
  return share.grantee_display_name ?? share.grantee_email ?? share.pending_email ?? t('shared.unknownRecipient')
}

function getRecipientSubtitle(share: MyShareEntry, t: TranslateFn): string {
  if (share.grantee_type === 'group') return t('shared.groupStatus')
  if (share.grantee_type === 'link') return t('shared.linkStatus')
  if (share.grantee_display_name && share.grantee_email) return share.grantee_email
  return share.pending_email ?? share.grantee_email ?? t('shared.unknownRecipient')
}

function getShareStatus(share: MyShareEntry, t: TranslateFn): string {
  if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) return t('shared.expiredStatus')
  if (share.pending_email) return t('shared.pendingInvite')
  if (share.grantee_type === 'group') return t('shared.groupStatus')
  if (share.grantee_type === 'link') return t('shared.linkStatus')
  return t('shared.activeStatus')
}

function getRecipientKind(share: MyShareEntry): RecipientKind {
  if (share.grantee_type === 'group') return 'group'
  if (share.grantee_type === 'link') return 'link'
  return 'user'
}

function buildRecipientGroups(data: MyShareGroup[], t: TranslateFn): RecipientShareGroup[] {
  const grouped = new Map<string, RecipientShareGroup>()

  for (const resourceGroup of data) {
    for (const share of resourceGroup.shares) {
      const key = getRecipientKey(share)
      const entry: RecipientShare = { share, item: resourceGroup.item }
      const existing = grouped.get(key)

      if (existing) {
        existing.shares.push(entry)
        continue
      }

      grouped.set(key, {
        key,
        kind: getRecipientKind(share),
        title: getRecipientTitle(share, t),
        subtitle: getRecipientSubtitle(share, t),
        status: getShareStatus(share, t),
        shares: [entry],
      })
    }
  }

  return Array.from(grouped.values())
    .map(group => ({
      ...group,
      shares: [...group.shares].sort((left, right) => left.item.full_path.localeCompare(right.item.full_path)),
    }))
    .sort((left, right) => left.title.localeCompare(right.title))
}

function buildShareCreateBody(params: {
  resourceId: string
  recipient: MyShareEntry
  permissions: SharePermissions
}): Record<string, unknown> | null {
  if (params.recipient.grantee_type === 'link') return null

  const body: Record<string, unknown> = {
    resource_id: params.resourceId,
    grantee_type: params.recipient.grantee_type,
    can_view: params.permissions.can_view,
    can_upload: params.permissions.can_upload,
    can_edit: params.permissions.can_edit,
    can_delete: params.permissions.can_delete,
    can_reshare: params.permissions.can_reshare,
  }

  if (params.recipient.grantee_type === 'group') {
    body.grantee_id = params.recipient.grantee_id
    return body
  }

  const email = params.recipient.pending_email ?? params.recipient.grantee_email
  if (!email) return null
  body.grantee_email = email
  return body
}

function buildShareUpdateBody(permissions: SharePermissions, isFolder: boolean): Record<string, boolean> {
  const body: Record<string, boolean> = {
    can_view: permissions.can_view,
    can_edit: permissions.can_edit,
    can_delete: permissions.can_delete,
    can_reshare: permissions.can_reshare,
  }

  if (isFolder) body.can_upload = permissions.can_upload
  return body
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function SharedPage() {
  const [tab, setTab] = useState<'received' | 'sent'>('received')
  const { t } = useI18n()

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">{t('shared.sharedWithMe')}</h1>

      <div className="flex gap-1 border-b border-zinc-200 dark:border-[#2d3148]">
        <button type="button"
          onClick={() => setTab('received')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'received'
              ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
              : 'border-transparent text-zinc-500 dark:text-slate-400 hover:text-zinc-800 dark:hover:text-slate-200'
          }`}
        >
          {t('shared.sharedWithMe')}
        </button>
        <button type="button"
          onClick={() => setTab('sent')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'sent'
              ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
              : 'border-transparent text-zinc-500 dark:text-slate-400 hover:text-zinc-800 dark:hover:text-slate-200'
          }`}
        >
          {t('shared.myShares')}
        </button>
      </div>

      {tab === 'received' ? <ReceivedTab /> : <SentTab />}
    </div>
  )
}

function ReceivedTab() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [previewItem, setPreviewItem] = useState<FileItem | null>(null)
  const [ooItem, setOoItem] = useState<FileItem | null>(null)
  const [teItem, setTeItem] = useState<FileItem | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['files', 'shared-with-me'],
    queryFn: ({ signal }) => api.get<SharedItem[]>('/api/v1/files/shared-with-me', signal),
    staleTime: 0,
  })

  const { data: systemSettings } = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: ({ signal }) => api.get<{ onlyoffice_url?: string }>('/api/v1/system/settings', signal),
    staleTime: 5 * 60 * 1000,
  })

  const items = (data ?? []).map(shareItem => ({
    id: shareItem.item.id,
    parent_id: null,
    owner_id: shareItem.share.owner_id,
    is_folder: shareItem.item.is_folder,
    name: shareItem.item.name,
    mime_type: shareItem.item.mime_type,
    size_bytes: shareItem.item.size_bytes,
    checksum_sha256: null,
    deleted_at: null,
    created_at: shareItem.item.created_at,
    updated_at: shareItem.item.created_at,
    shared: true,
    permissions: {
      can_view: shareItem.share.can_view,
      can_upload: shareItem.share.can_upload,
      can_edit: shareItem.share.can_edit,
      can_delete: shareItem.share.can_delete,
      can_reshare: shareItem.share.can_reshare,
      is_owner: false,
    },
  }))

  const handleOpen = (item: FileItem) => {
    if (item.is_folder) {
      ignorePromise(navigate({ to: '/shared-browse', search: { folder: item.id } }))
      return
    }

    if (systemSettings?.onlyoffice_url && shouldOpenInOnlyOffice(item.name)) {
      setOoItem(item)
      return
    }

    if (shouldOpenInTextEditor(item.name)) {
      setTeItem(item)
      return
    }

    setPreviewItem(item)
  }

  let receivedContent: React.ReactNode
  if (isLoading) {
    receivedContent = (
      <div className="flex items-center justify-center h-40 text-sm text-zinc-400 dark:text-slate-500">{t('files.loading')}</div>
    )
  } else if (items.length === 0) {
    receivedContent = (
      <div className="flex items-center justify-center h-40 text-sm text-zinc-400 dark:text-slate-500">{t('files.nothingShared')}</div>
    )
  } else {
    receivedContent = (
      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
        <FileList
          items={items}
          selectedIds={selected}
          onSelect={(id, add) => {
            setSelected(previous => {
              const next = new Set(add ? previous : [])
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }}
          onOpen={handleOpen}
          onContextMenu={() => {}}
        />
      </div>
    )
  }

  return (
    <>
      {receivedContent}
      {previewItem && <PreviewModal item={previewItem} onClose={() => setPreviewItem(null)} />}
      {ooItem && systemSettings?.onlyoffice_url && (
        <OnlyOfficeEditor
          item={ooItem}
          onlyofficeUrl={systemSettings.onlyoffice_url}
          backLabel={t('shared.sharedWithMe')}
          onClose={() => setOoItem(null)}
        />
      )}
      {teItem && <TextEditor item={teItem} onClose={() => setTeItem(null)} />}
    </>
  )
}
function ActionIconButton({
  icon: Icon,
  title,
  onClick,
  className = 'text-zinc-400 hover:text-indigo-500 dark:hover:text-indigo-300',
}: Readonly<{
  icon: React.ComponentType<{ className?: string }>
  title: string
  onClick: () => void
  className?: string
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-[#2d3148] transition-colors ${className}`}
    >
      <Icon className="w-4 h-4" />
    </button>
  )
}

function ShareActionButtons({
  onView,
  onUpload,
  onEdit,
  onDelete,
  onReshare,
}: Readonly<{
  onView: () => void
  onUpload: () => void
  onEdit: () => void
  onDelete: () => void
  onReshare: () => void
}>) {
  const { t } = useI18n()
  const actions: ReadonlyArray<{ key: string; label: string; onClick: () => void; className?: string }> = [
    { key: 'view', label: t('share.permView'), onClick: onView },
    { key: 'upload', label: t('share.permUpload'), onClick: onUpload },
    { key: 'edit', label: t('share.permEdit'), onClick: onEdit },
    { key: 'delete', label: t('share.permDelete'), onClick: onDelete, className: 'text-red-600 dark:text-red-300' },
    { key: 'reshare', label: t('share.permReshare'), onClick: onReshare },
  ]

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
      {actions.map(action => (
        <button
          key={action.key}
          type="button"
          onClick={action.onClick}
          className={[
            'text-xs font-medium text-zinc-600 underline-offset-4 transition-colors hover:text-indigo-600 hover:underline dark:text-slate-300 dark:hover:text-indigo-300',
            action.className ?? '',
          ].join(' ').trim()}
        >
          {action.label}
        </button>
      ))}
    </div>
  )
}

function PermissionSummary({
  share,
  isFolder,
}: Readonly<{
  share: MyShareEntry
  isFolder: boolean
}>) {
  const { t } = useI18n()
  const fields = getPermissionFields(isFolder)

  return (
    <div className="flex flex-wrap gap-1.5">
      {PERMISSION_META.filter(permission => fields.includes(permission.field)).map(permission => (
        <span
          key={permission.field}
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
            share[permission.field]
              ? permission.activeClassName
              : 'border-zinc-200 text-zinc-400 dark:border-[#3a3f57] dark:text-slate-500'
          }`}
        >
          {t(permission.labelKey)}
        </span>
      ))}
    </div>
  )
}

function PermissionEditor({
  permissions,
  isFolder,
  disabled,
  onChange,
}: Readonly<{
  permissions: SharePermissions
  isFolder: boolean
  disabled: boolean
  onChange: (next: SharePermissions) => void
}>) {
  const { t } = useI18n()
  const fields = getPermissionFields(isFolder)

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {PERMISSION_META.filter(permission => fields.includes(permission.field)).map(permission => (
        <label key={permission.field} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={permissions[permission.field]}
            disabled={disabled}
            onChange={event => onChange({ ...permissions, [permission.field]: event.target.checked })}
            className="rounded border-zinc-300 dark:border-[#4d5678] text-brand-600"
          />
          <span>{t(permission.labelKey)}</span>
        </label>
      ))}
    </div>
  )
}

function RecipientIcon({ kind }: Readonly<{ kind: RecipientKind }>) {
  if (kind === 'group') return <Users className="w-4 h-4 text-violet-400 shrink-0" />
  if (kind === 'link') return <LinkIcon className="w-4 h-4 text-amber-400 shrink-0" />
  return <UserRound className="w-4 h-4 text-indigo-400 shrink-0" />
}

function RecipientShareCard({
  group,
  expanded,
  onToggleExpanded,
  onView,
  onOpenInFiles,
  onEdit,
  onReshare,
  onDelete,
}: Readonly<{
  group: RecipientShareGroup
  expanded: boolean
  onToggleExpanded: () => void
  onView: () => void
  onOpenInFiles: () => void
  onEdit: () => void
  onReshare: () => void
  onDelete: () => void
}>) {
  const { t } = useI18n()
  const previewShares = expanded ? group.shares : group.shares.slice(0, 2)
  const remainingCount = group.shares.length - previewShares.length
  let toggleLabel = t('shared.sharedFolders')
  if (expanded) toggleLabel = t('share.collapse')
  else if (remainingCount > 0) toggleLabel = t('shared.moreFolders', { n: String(remainingCount) })

  return (
    <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
      <div className="flex items-start gap-3 px-4 py-4 border-b border-zinc-100 dark:border-[#2d3148]">
        <div className="mt-0.5 w-9 h-9 rounded-full bg-zinc-100 dark:bg-[#111521] flex items-center justify-center shrink-0">
          <RecipientIcon kind={group.kind} />
        </div>

        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100 truncate">{group.title}</h2>
            <span className="inline-flex items-center rounded-full border border-zinc-200 dark:border-[#39405a] px-2 py-0.5 text-[11px] text-zinc-500 dark:text-slate-400">
              {group.status}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-slate-400">
            <span className="inline-flex items-center gap-1">
              <Mail className="w-3.5 h-3.5" />
              {group.subtitle}
            </span>
            <span>{t('shared.folderCount', { n: String(group.shares.length) })}</span>
          </div>
        </div>

      </div>

      <div className="px-4 py-3 space-y-2.5">
        {previewShares.map(entry => (
          <div key={entry.share.id} className="rounded-lg border border-zinc-100 dark:border-[#2d3148] bg-zinc-50/60 dark:bg-[#111521] px-3 py-2.5">
            <div className="flex items-start gap-2">
              <Folder className="w-4 h-4 mt-0.5 text-indigo-400 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-zinc-900 dark:text-slate-100">{entry.item.name}</p>
                  <span className="text-[11px] text-zinc-400 dark:text-slate-500">{getShareStatus(entry.share, t)}</span>
                </div>
                <p className="text-xs text-zinc-500 dark:text-slate-400 break-all">{entry.item.full_path}</p>
                <ShareActionButtons
                  onView={onView}
                  onUpload={onOpenInFiles}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onReshare={onReshare}
                />
              </div>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={onToggleExpanded}
          className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
        >
          {toggleLabel}
        </button>
      </div>
    </div>
  )
}

function DialogShell({
  title,
  subtitle,
  onClose,
  children,
}: Readonly<{
  title: string
  subtitle?: string
  onClose: () => void
  children: React.ReactNode
}>) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button type="button" aria-label="Close dialog" className="absolute inset-0 bg-black/55" onClick={onClose} />
      <div className="relative z-10 w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-[#2d3148] dark:bg-[#1a1d27]">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-100 px-5 py-4 dark:border-[#2d3148]">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-slate-100">{title}</h3>
            {subtitle && <p className="mt-1 text-sm text-zinc-500 dark:text-slate-400 truncate">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-[#2d3148] dark:hover:text-slate-200"
          >
            <span className="text-lg leading-none">×</span>
          </button>
        </div>
        <div className="max-h-[calc(90vh-81px)] overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}
function ShareDetailsDialog({
  group,
  onClose,
  onOpenInFiles,
}: Readonly<{
  group: RecipientShareGroup
  onClose: () => void
  onOpenInFiles: (entry: RecipientShare) => void
}>) {
  const { t } = useI18n()

  return (
    <DialogShell title={t('shared.detailsTitle')} subtitle={group.title} onClose={onClose}>
      <div className="p-5 space-y-4">
        <div className="grid gap-3 rounded-xl border border-zinc-200 bg-zinc-50/70 p-4 text-sm dark:border-[#2d3148] dark:bg-[#111521] md:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-slate-400">{t('shared.recipientName')}</p>
            <p className="mt-1 text-zinc-900 dark:text-slate-100">{group.title}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-slate-400">{t('shared.recipientEmail')}</p>
            <p className="mt-1 text-zinc-900 dark:text-slate-100">{group.subtitle}</p>
          </div>
        </div>

        <div className="space-y-3">
          {group.shares.map(entry => (
            <div key={entry.share.id} className="rounded-xl border border-zinc-200 px-4 py-4 dark:border-[#2d3148]">
              <div className="flex items-start gap-3">
                <Folder className="w-4 h-4 mt-1 text-indigo-400 shrink-0" />
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-zinc-900 dark:text-slate-100">{entry.item.name}</p>
                    <span className="inline-flex items-center rounded-full border border-zinc-200 dark:border-[#39405a] px-2 py-0.5 text-[11px] text-zinc-500 dark:text-slate-400">
                      {getShareStatus(entry.share, t)}
                    </span>
                  </div>

                  <div className="grid gap-3 text-sm md:grid-cols-2">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-slate-400">{t('shared.fullPath')}</p>
                      <p className="mt-1 break-all text-zinc-900 dark:text-slate-100">{entry.item.full_path}</p>
                    </div>
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-slate-400">{t('shared.createdAt')}</p>
                      <p className="mt-1 inline-flex items-center gap-1 text-zinc-900 dark:text-slate-100">
                        <Clock className="w-3.5 h-3.5 text-zinc-400" />
                        {formatDate(entry.share.created_at)}
                      </p>
                    </div>
                  </div>

                  <div>
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-slate-400">{t('shared.accessLevel')}</p>
                    <PermissionSummary share={entry.share} isFolder={entry.item.is_folder} />
                  </div>
                </div>

                <ActionIconButton icon={FolderOpen} title={t('shared.openSharedFolder')} onClick={() => onOpenInFiles(entry)} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </DialogShell>
  )
}
function ManageShareDialog({
  group,
  onClose,
  onOpenInFiles,
  onUpdatePermissions,
  onRemoveShare,
  onAddFolder,
}: Readonly<{
  group: RecipientShareGroup
  onClose: () => void
  onOpenInFiles: (entry: RecipientShare) => void
  onUpdatePermissions: (entry: RecipientShare, permissions: SharePermissions) => Promise<void>
  onRemoveShare: (entry: RecipientShare) => Promise<void>
  onAddFolder: (group: RecipientShareGroup, folderId: string | null, permissions: SharePermissions) => Promise<boolean>
}>) {
  const { t } = useI18n()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [newFolderPermissions, setNewFolderPermissions] = useState<SharePermissions>(
    group.shares[0] ? mapSharePermissions(group.shares[0].share) : DEFAULT_PERMISSIONS,
  )
  const [draftPermissions, setDraftPermissions] = useState<Record<string, SharePermissions>>(() =>
    Object.fromEntries(group.shares.map(entry => [entry.share.id, mapSharePermissions(entry.share)])),
  )

  const isLinkShare = group.kind === 'link'

  const handleSave = async (entry: RecipientShare) => {
    setBusyId(entry.share.id)
    try {
      await onUpdatePermissions(entry, draftPermissions[entry.share.id])
    } finally {
      setBusyId(null)
    }
  }

  const handleRemove = async (entry: RecipientShare) => {
    setBusyId(`remove:${entry.share.id}`)
    try {
      await onRemoveShare(entry)
    } finally {
      setBusyId(null)
    }
  }

  const handleAddFolder = async (folderId: string | null) => {
    setBusyId('add-folder')
    try {
      const created = await onAddFolder(group, folderId, newFolderPermissions)
      if (created) {
        setPickerOpen(false)
        onClose()
      }
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <DialogShell title={t('shared.manageTitle')} subtitle={group.title} onClose={onClose}>
        <div className="p-5 space-y-5">
          {!isLinkShare && (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-4 dark:border-[#2d3148] dark:bg-[#111521] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">{t('shared.addFolderToShare')}</h4>
                  <p className="text-sm text-zinc-500 dark:text-slate-400">{t('shared.chooseFolder')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
                >
                  <FolderPlus className="w-4 h-4" />
                  {t('shared.addFolder')}
                </button>
              </div>
              <PermissionEditor
                permissions={newFolderPermissions}
                isFolder={true}
                disabled={busyId === 'add-folder'}
                onChange={setNewFolderPermissions}
              />
            </div>
          )}

          <div className="space-y-4">
            {group.shares.map(entry => {
              const saveBusy = busyId === entry.share.id
              const removeBusy = busyId === `remove:${entry.share.id}`
              return (
                <div key={entry.share.id} className="rounded-xl border border-zinc-200 p-4 dark:border-[#2d3148] space-y-4">
                  <div className="flex items-start gap-3">
                    <Folder className="w-4 h-4 mt-1 text-indigo-400 shrink-0" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-zinc-900 dark:text-slate-100">{entry.item.name}</p>
                        <span className="text-[11px] text-zinc-500 dark:text-slate-400">{getShareStatus(entry.share, t)}</span>
                      </div>
                      <p className="text-xs break-all text-zinc-500 dark:text-slate-400">{entry.item.full_path}</p>
                      <p className="text-xs text-zinc-400 dark:text-slate-500">{t('shared.createdAt')}: {formatDate(entry.share.created_at)}</p>
                    </div>
                    <ActionIconButton icon={FolderOpen} title={t('shared.openSharedFolder')} onClick={() => onOpenInFiles(entry)} />
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-slate-400">{t('shared.accessLevel')}</p>
                    <PermissionEditor
                      permissions={draftPermissions[entry.share.id]}
                      isFolder={entry.item.is_folder}
                      disabled={saveBusy || removeBusy}
                      onChange={next => setDraftPermissions(previous => ({ ...previous, [entry.share.id]: next }))}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => ignorePromise(handleRemove(entry))}
                      disabled={saveBusy || removeBusy}
                      className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-500/10"
                    >
                      {t('shared.removeFolderFromShare')}
                    </button>
                    <button
                      type="button"
                      onClick={() => ignorePromise(handleSave(entry))}
                      disabled={saveBusy || removeBusy}
                      className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
                    >
                      {saveBusy ? t('share.sharing') : t('share.saveChanges')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </DialogShell>

      {pickerOpen && (
        <FolderPickerDialog
          title={t('shared.chooseFolder')}
          confirmLabel={t('shared.addFolder')}
          onClose={() => setPickerOpen(false)}
          onConfirm={folderId => {
            ignorePromise(handleAddFolder(folderId))
          }}
        />
      )}
    </>
  )
}
function ReshareDialog({
  group,
  onClose,
  onSubmit,
}: Readonly<{
  group: RecipientShareGroup
  onClose: () => void
  onSubmit: (email: string, resourceIds: string[], permissions: SharePermissions) => Promise<boolean>
}>) {
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [permissions, setPermissions] = useState<SharePermissions>(
    group.shares[0] ? mapSharePermissions(group.shares[0].share) : DEFAULT_PERMISSIONS,
  )
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(group.shares.map(entry => entry.item.id)))
  const [isSubmitting, setIsSubmitting] = useState(false)

  const toggleSelection = (resourceId: string) => {
    setSelectedIds(previous => {
      const next = new Set(previous)
      if (next.has(resourceId)) next.delete(resourceId)
      else next.add(resourceId)
      return next
    })
  }

  const handleSubmit = async () => {
    setIsSubmitting(true)
    try {
      const success = await onSubmit(email.trim(), Array.from(selectedIds), permissions)
      if (success) onClose()
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <DialogShell title={t('shared.shareWithAnother')} subtitle={group.title} onClose={onClose}>
      <div className="p-5 space-y-5">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-zinc-600 dark:text-slate-400">{t('share.emailLabel')}</label>
          <input
            type="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            placeholder={t('share.emailPlaceholder')}
            className="w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-[#2d3148] dark:bg-[#111521] dark:text-slate-100"
          />
        </div>

        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-slate-400">{t('shared.selectedFolders')}</p>
          <div className="space-y-2">
            {group.shares.map(entry => {
              const checkboxId = `reshare-folder-${entry.share.id}`
              const nameId = `reshare-folder-name-${entry.share.id}`
              const pathId = `reshare-folder-path-${entry.share.id}`

              return (
                <div key={entry.share.id} className="flex items-start gap-3 rounded-xl border border-zinc-200 px-3 py-3 dark:border-[#2d3148]">
                  <input
                    id={checkboxId}
                    type="checkbox"
                    checked={selectedIds.has(entry.item.id)}
                    onChange={() => toggleSelection(entry.item.id)}
                    aria-labelledby={nameId}
                    aria-describedby={pathId}
                    className="mt-1 rounded border-zinc-300 text-brand-600 dark:border-[#4d5678]"
                  />
                  <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer space-y-1">
                    <p id={nameId} className="text-sm font-medium text-zinc-900 dark:text-slate-100">{entry.item.name}</p>
                    <p id={pathId} className="text-xs break-all text-zinc-500 dark:text-slate-400">{entry.item.full_path}</p>
                  </label>
                </div>
              )
            })}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-slate-400">{t('shared.accessLevel')}</p>
          <PermissionEditor permissions={permissions} isFolder={true} disabled={isSubmitting} onChange={setPermissions} />
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-[#2d3148] dark:text-slate-300 dark:hover:bg-[#2d3148]"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => ignorePromise(handleSubmit())}
            disabled={isSubmitting}
            className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            {isSubmitting ? t('share.sharing') : t('shared.sendShare')}
          </button>
        </div>
      </div>
    </DialogShell>
  )
}

function RevokeShareDialog({
  group,
  onClose,
  onConfirm,
}: Readonly<{
  group: RecipientShareGroup
  onClose: () => void
  onConfirm: (group: RecipientShareGroup) => Promise<boolean>
}>) {
  const { t } = useI18n()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleConfirm = async () => {
    setIsSubmitting(true)
    try {
      const success = await onConfirm(group)
      if (success) onClose()
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <DialogShell title={t('shared.deleteShareGroup')} subtitle={group.title} onClose={onClose}>
      <div className="p-5 space-y-5">
        <p className="text-sm leading-6 text-zinc-600 dark:text-slate-300">
          {t('shared.deleteRecipientConfirm', { name: group.title })}
        </p>

        <div className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-4 dark:border-[#2d3148] dark:bg-[#111521] space-y-2">
          {group.shares.map(entry => (
            <div key={entry.share.id} className="flex items-start gap-2 text-sm text-zinc-700 dark:text-slate-300">
              <Folder className="mt-0.5 w-4 h-4 text-indigo-400 shrink-0" />
              <div>
                <p className="font-medium">{entry.item.name}</p>
                <p className="text-xs break-all text-zinc-500 dark:text-slate-400">{entry.item.full_path}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-[#2d3148] dark:text-slate-300 dark:hover:bg-[#2d3148]"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => ignorePromise(handleConfirm())}
            disabled={isSubmitting}
            className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            {isSubmitting ? t('share.sharing') : t('shared.deleteShareGroup')}
          </button>
        </div>
      </div>
    </DialogShell>
  )
}
function SentTab() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [detailsKey, setDetailsKey] = useState<string | null>(null)
  const [manageKey, setManageKey] = useState<string | null>(null)
  const [reshareKey, setReshareKey] = useState<string | null>(null)
  const [deleteKey, setDeleteKey] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['files', 'my-shares'],
    queryFn: ({ signal }) => api.get<MyShareGroup[]>('/api/v1/files/my-shares', signal),
    staleTime: 0,
  })

  const recipientGroups = buildRecipientGroups(data ?? [], t)
  const detailsGroup = recipientGroups.find(group => group.key === detailsKey) ?? null
  const manageGroup = recipientGroups.find(group => group.key === manageKey) ?? null
  const reshareGroup = recipientGroups.find(group => group.key === reshareKey) ?? null
  const deleteGroup = recipientGroups.find(group => group.key === deleteKey) ?? null

  const refreshMyShares = async () => {
    await qc.invalidateQueries({ queryKey: ['files', 'my-shares'] })
  }

  const toggleExpanded = (groupKey: string) => {
    setExpandedGroups(previous => {
      const next = new Set(previous)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }

  const openInMyFiles = (entry: RecipientShare) => {
    if (entry.item.is_folder) {
      ignorePromise(navigate({ to: '/files', search: { folder: entry.item.id } }))
      return
    }

    ignorePromise(navigate({ to: '/files', search: entry.item.parent_id ? { folder: entry.item.parent_id } : {} }))
  }

  const openRecipientInMyFiles = (group: RecipientShareGroup) => {
    const firstShare = group.shares[0]
    if (firstShare) openInMyFiles(firstShare)
  }

  const updatePermissions = async (entry: RecipientShare, permissions: SharePermissions) => {
    try {
      await api.patch(`/api/v1/shares/${entry.share.id}`, buildShareUpdateBody(permissions, entry.item.is_folder))
      await refreshMyShares()
      toast.success(t('share.updated'))
    } catch (error) {
      toast.error(getErrorMessage(error, t('share.updateFailed')))
      throw error
    }
  }

  const removeSingleShare = async (entry: RecipientShare) => {
    try {
      await api.delete(`/api/v1/shares/${entry.share.id}`)
      await refreshMyShares()
      toast.success(t('shared.revokeShare'))
    } catch (error) {
      toast.error(getErrorMessage(error, t('share.revokeFailed')))
      throw error
    }
  }

  const addFolderToShare = async (group: RecipientShareGroup, folderId: string | null, permissions: SharePermissions): Promise<boolean> => {
    if (!folderId) {
      toast.error(t('shared.chooseFolderFirst'))
      return false
    }

    const body = buildShareCreateBody({
      resourceId: folderId,
      recipient: group.shares[0].share,
      permissions,
    })

    if (!body) {
      toast.error(t('shared.cannotExtendLinkShare'))
      return false
    }

    try {
      await api.post('/api/v1/shares', body)
      await refreshMyShares()
      toast.success(t('share.created'))
      return true
    } catch (error) {
      toast.error(getErrorMessage(error, t('share.createFailed')))
      return false
    }
  }

  const reshareFolders = async (email: string, resourceIds: string[], permissions: SharePermissions): Promise<boolean> => {
    if (!email) {
      toast.error(t('shared.enterRecipientEmail'))
      return false
    }
    if (resourceIds.length === 0) {
      toast.error(t('shared.noFoldersSelected'))
      return false
    }

    const results = await Promise.allSettled(
      resourceIds.map(resourceId =>
        api.post('/api/v1/shares', {
          resource_id: resourceId,
          grantee_type: 'user',
          grantee_email: email,
          can_view: permissions.can_view,
          can_upload: permissions.can_upload,
          can_edit: permissions.can_edit,
          can_delete: permissions.can_delete,
          can_reshare: permissions.can_reshare,
        }),
      ),
    )

    const successCount = results.filter(result => result.status === 'fulfilled').length
    const failureCount = results.length - successCount

    if (successCount > 0) await refreshMyShares()

    if (successCount > 0 && failureCount === 0) {
      toast.success(t('shared.shareSentCount', { n: String(successCount) }))
      return true
    }

    if (successCount > 0) {
      toast.error(t('shared.shareSentPartial', { success: String(successCount), failed: String(failureCount) }))
      return true
    }

    const failed = results.find(result => result.status === 'rejected')
    toast.error(failed && 'reason' in failed ? getErrorMessage(failed.reason, t('share.createFailed')) : t('share.createFailed'))
    return false
  }

  const revokeRecipientGroup = async (group: RecipientShareGroup): Promise<boolean> => {
    const results = await Promise.allSettled(group.shares.map(entry => api.delete(`/api/v1/shares/${entry.share.id}`)))
    const successCount = results.filter(result => result.status === 'fulfilled').length

    if (successCount > 0) await refreshMyShares()

    if (successCount === group.shares.length) {
      toast.success(t('shared.revokeShare'))
      return true
    }

    toast.error(t('share.revokeFailed'))
    return false
  }

  if (isLoading) {
    return <div className="flex items-center justify-center h-40 text-sm text-zinc-400 dark:text-slate-500">{t('files.loading')}</div>
  }

  if (recipientGroups.length === 0) {
    return <div className="flex items-center justify-center h-40 text-sm text-zinc-400 dark:text-slate-500">{t('shared.noShares')}</div>
  }

  return (
    <>
      <div className="space-y-3">
        {recipientGroups.map(group => (
          <RecipientShareCard
            key={group.key}
            group={group}
            expanded={expandedGroups.has(group.key)}
            onToggleExpanded={() => toggleExpanded(group.key)}
            onView={() => setDetailsKey(group.key)}
            onOpenInFiles={() => openRecipientInMyFiles(group)}
            onEdit={() => setManageKey(group.key)}
            onReshare={() => setReshareKey(group.key)}
            onDelete={() => setDeleteKey(group.key)}
          />
        ))}
      </div>

      {detailsGroup && (
        <ShareDetailsDialog
          group={detailsGroup}
          onClose={() => setDetailsKey(null)}
          onOpenInFiles={openInMyFiles}
        />
      )}

      {manageGroup && (
        <ManageShareDialog
          group={manageGroup}
          onClose={() => setManageKey(null)}
          onOpenInFiles={openInMyFiles}
          onUpdatePermissions={updatePermissions}
          onRemoveShare={removeSingleShare}
          onAddFolder={addFolderToShare}
        />
      )}

      {reshareGroup && (
        <ReshareDialog
          group={reshareGroup}
          onClose={() => setReshareKey(null)}
          onSubmit={reshareFolders}
        />
      )}

      {deleteGroup && (
        <RevokeShareDialog
          group={deleteGroup}
          onClose={() => setDeleteKey(null)}
          onConfirm={revokeRecipientGroup}
        />
      )}
    </>
  )
}
