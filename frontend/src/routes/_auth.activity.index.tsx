import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { fetchActivity } from '@/lib/api'
import type { ActivityEvent } from '@/types/api'
import { formatRelative } from '@/lib/utils'
import {
  UploadCloud,
  Download,
  Eye,
  Archive,
  Trash2,
  RotateCcw,
  FolderInput,
  Pencil,
  FolderPlus,
  FileQuestion,
} from 'lucide-react'
import { useI18n } from '@/lib/i18n'

export const Route = createFileRoute('/_auth/activity/')({
  component: ActivityPage,
})

const EVENT_LABEL_KEYS: Record<string, string> = {
  FILE_UPLOADED:   'activity.uploaded',
  FILE_DOWNLOADED: 'activity.downloaded',
  FILE_PREVIEWED:  'activity.previewed',
  ZIP_DOWNLOADED:  'activity.downloadedZip',
  FILE_DELETED:    'activity.deleted',
  FILE_RESTORED:   'activity.restored',
  FILE_MOVED:      'activity.moved',
  FILE_RENAMED:    'activity.renamed',
  FOLDER_CREATED:  'activity.createdFolder',
}

function EventIcon({ type }: Readonly<{ type: string }>) {
  const cls = 'shrink-0'
  switch (type) {
    case 'FILE_UPLOADED':   return <UploadCloud size={15} className={cls} />
    case 'FILE_DOWNLOADED': return <Download    size={15} className={cls} />
    case 'FILE_PREVIEWED':  return <Eye         size={15} className={cls} />
    case 'ZIP_DOWNLOADED':  return <Archive     size={15} className={cls} />
    case 'FILE_DELETED':    return <Trash2      size={15} className={cls} />
    case 'FILE_RESTORED':   return <RotateCcw   size={15} className={cls} />
    case 'FILE_MOVED':      return <FolderInput size={15} className={cls} />
    case 'FILE_RENAMED':    return <Pencil      size={15} className={cls} />
    case 'FOLDER_CREATED':  return <FolderPlus  size={15} className={cls} />
    default:                return <FileQuestion size={15} className={cls} />
  }
}

function ActivityPage() {
  const { t } = useI18n()
  const { data, isLoading } = useQuery<ActivityEvent[]>({
    queryKey: ['me', 'activity'],
    queryFn: fetchActivity,
  })

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-slate-100">{t('page.activity')}</h1>

      <div className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-40 text-sm text-muted">{t('files.loading')}</div>
        ) : !data?.length ? (
          <div className="flex items-center justify-center h-40 text-sm text-muted">{t('files.noActivity')}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 dark:border-[#2d3148]">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted uppercase w-8" />
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted uppercase">{t('activity.action')}</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted uppercase">{t('activity.file')}</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted uppercase hidden md:table-cell">{t('activity.ip')}</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted uppercase">{t('activity.when')}</th>
              </tr>
            </thead>
            <tbody>
              {data.map(ev => (
                <tr
                  key={ev.id}
                  className="border-b border-zinc-50 dark:border-[#2d3148]/50"
                >
                  <td className="px-4 py-2.5 text-muted">
                    <EventIcon type={ev.event_type} />
                  </td>
                  <td className="px-4 py-2.5 text-zinc-800 dark:text-slate-200">
                    {t((EVENT_LABEL_KEYS[ev.event_type] ?? ev.event_type) as any)}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-600 dark:text-slate-400 max-w-xs truncate">
                    {ev.resource_name ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted text-right hidden md:table-cell tabular-nums">
                    {ev.ip_address || '—'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted text-right whitespace-nowrap">
                    {formatRelative(ev.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
