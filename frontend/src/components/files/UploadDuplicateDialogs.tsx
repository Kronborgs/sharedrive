import type { DuplicateUploadEntry, UploadConflictPair } from '@/lib/upload-duplicates'

interface UploadConflictDialogProps {
  open: boolean
  queue: UploadConflictPair[]
  applyAll: boolean
  onApplyAllChange: (value: boolean) => void
  onClose: () => void
  onResolve: (choice: 'overwrite' | 'skip') => void
  compareUpdatedLabel: (incoming: File, existing: { updated_at: string }) => string
  t: (...args: any[]) => string
}

export function UploadConflictDialog({
  open,
  queue,
  applyAll,
  onApplyAllChange,
  onClose,
  onResolve,
  compareUpdatedLabel,
  t,
}: UploadConflictDialogProps) {
  if (!open || queue.length === 0) return null

  const current = queue[0]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        aria-label="Close conflict dialog"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div className="relative z-10 bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-5 w-[min(90vw,28rem)] space-y-4 shadow-xl">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">{t('upload.conflictTitle')}</h3>
          <p className="text-sm text-muted mt-1">{t('upload.conflictSubtitle')}</p>
        </div>
        <div className="rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] p-3">
          <p className="text-sm font-medium text-zinc-900 dark:text-slate-100 break-all">{current.incoming.name}</p>
          <p className="text-xs text-zinc-500 dark:text-slate-400 mt-1">
            {compareUpdatedLabel(current.incoming, current.existing)}
          </p>
          <p className="text-xs text-zinc-500 dark:text-slate-400 mt-1">
            {t('upload.conflictExistingUpdated', {
              date: new Date(current.existing.updated_at).toLocaleString(),
            })}
          </p>
        </div>
        {queue.length > 1 && (
          <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-slate-300">
            <input
              type="checkbox"
              className="rounded border-zinc-300 dark:border-zinc-600"
              checked={applyAll}
              onChange={e => onApplyAllChange(e.target.checked)}
            />
            {t('upload.conflictApplyToAll', { count: String(queue.length) })}
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onResolve('skip')}
            className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-zinc-700 dark:text-slate-300"
          >
            {t('upload.conflictSkip')}
          </button>
          <button
            type="button"
            onClick={() => onResolve('overwrite')}
            className="px-4 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium"
          >
            {t('upload.conflictOverwrite')}
          </button>
        </div>
      </div>
    </div>
  )
}

interface UploadGlobalDuplicateDialogProps {
  open: boolean
  queue: DuplicateUploadEntry[]
  renames: Record<string, string>
  onRename: (id: string, value: string) => void
  onClose: () => void
  onConfirm: () => void
  t: (...args: any[]) => string
}

export function UploadGlobalDuplicateDialog({
  open,
  queue,
  renames,
  onRename,
  onClose,
  onConfirm,
  t,
}: UploadGlobalDuplicateDialogProps) {
  if (!open || queue.length === 0) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <button
        type="button"
        aria-label="Close duplicate dialog"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div className="relative z-10 bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-5 w-[min(90vw,34rem)] space-y-4 shadow-xl">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">{t('upload.globalDuplicateTitle')}</h3>
          <p className="text-sm text-muted mt-1">{t('upload.globalDuplicateSubtitle')}</p>
        </div>
        <div className="max-h-56 overflow-y-auto space-y-3">
          {queue.map(({ id, incoming, matches }) => (
            <div key={id} className="rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] p-3 space-y-2">
              <p className="text-sm font-medium text-zinc-900 dark:text-slate-100 break-all">{incoming.file.name}</p>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-zinc-500 dark:text-slate-400">{t('upload.globalDuplicateRename')}</span>
                <input
                  type="text"
                  value={renames[id] ?? incoming.file.name}
                  onChange={e => onRename(id, e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] px-3 py-1.5 text-sm text-zinc-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </label>
              <p className="text-xs text-zinc-500 dark:text-slate-400">{t('upload.globalDuplicateLocations')}</p>
              <ul className="space-y-1 text-xs text-zinc-600 dark:text-slate-400">
                {matches.map(match => (
                  <li key={match.id} className="break-all">{match.full_path}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-zinc-700 dark:text-slate-300"
          >
            {t('upload.globalDuplicateCancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium"
          >
            {t('upload.globalDuplicateContinue')}
          </button>
        </div>
      </div>
    </div>
  )
}
