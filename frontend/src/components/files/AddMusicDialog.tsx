import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Folder, Music, ChevronRight, X, Check, Plus } from 'lucide-react'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { FileItem } from '@/types/api'

// MIME types recognised as audio
const AUDIO_MIME = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/vorbis', 'audio/flac',
  'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/m4a', 'audio/mp4',
  'audio/x-m4a', 'audio/opus', 'audio/webm', 'audio/wma', 'audio/x-ms-wma',
])

function isAudio(item: FileItem) {
  if (item.is_folder) return false
  if (item.mime_type && AUDIO_MIME.has(item.mime_type)) return true
  const ext = item.name.split('.').pop()?.toLowerCase() ?? ''
  return ['mp3', 'ogg', 'flac', 'wav', 'aac', 'm4a', 'opus', 'wma', 'webm'].includes(ext)
}

interface BreadcrumbEntry { id: string | null; name: string }

interface Props {
  /** Called when the user closes without adding */
  onClose: () => void
  /** Called with IDs of selected audio files */
  onAdd: (fileIds: string[]) => void
}

export function AddMusicDialog({ onClose, onAdd }: Props) {
  const { t } = useI18n()
  const [folderId, setFolderId] = useState<string | null>(null)
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([{ id: null, name: t('nav.myFiles' as any) }])
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['add-music-browse', folderId],
    queryFn: ({ signal }) =>
      api.get<FileItem[]>(`/api/v1/files?${folderId ? `parent_id=${folderId}` : ''}`, signal),
    select: (data) => data ?? [],
    staleTime: 30_000,
  })

  const folders = items.filter(i => i.is_folder)
  const audioFiles = items.filter(isAudio)

  function openFolder(item: FileItem) {
    setFolderId(item.id)
    setBreadcrumbs(prev => [...prev, { id: item.id, name: item.name }])
  }

  function navigateTo(idx: number) {
    const crumb = breadcrumbs[idx]
    setFolderId(crumb.id)
    setBreadcrumbs(prev => prev.slice(0, idx + 1))
  }

  function toggleFile(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAll() {
    setSelected(prev => {
      const next = new Set(prev)
      audioFiles.forEach(f => next.add(f.id))
      return next
    })
  }

  function confirm() {
    if (selected.size === 0) return
    onAdd([...selected])
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Dialog */}
      <div className="relative z-10 bg-white dark:bg-[#1a1d27] rounded-2xl shadow-2xl border border-zinc-200 dark:border-[#2d3148] w-full max-w-md mx-4 flex flex-col max-h-[80vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-[#2d3148] shrink-0">
          <div className="flex items-center gap-2">
            <Music size={16} className="text-brand-500" />
            <span className="font-semibold text-sm text-zinc-900 dark:text-slate-100">
              {t('player.addMusic' as any)}
            </span>
          </div>
          <button onClick={onClose} className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-slate-200">
            <X size={16} />
          </button>
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center gap-1 px-4 py-2 text-xs text-zinc-500 dark:text-slate-400 border-b border-zinc-100 dark:border-[#2d3148] flex-wrap shrink-0">
          {breadcrumbs.map((crumb, idx) => (
            <span key={idx} className="flex items-center gap-1">
              {idx > 0 && <ChevronRight size={10} className="text-zinc-300" />}
              <button
                onClick={() => navigateTo(idx)}
                className={cn(
                  'hover:text-brand-600 dark:hover:text-brand-400 transition-colors',
                  idx === breadcrumbs.length - 1 ? 'font-medium text-zinc-700 dark:text-slate-300' : '',
                )}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto min-h-0 divide-y divide-zinc-50 dark:divide-[#2d3148]">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-sm text-zinc-400">
              {t('files.loading' as any)}
            </div>
          ) : (
            <>
              {/* Folders */}
              {folders.map(folder => (
                <button
                  key={folder.id}
                  onClick={() => openFolder(folder)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                >
                  <Folder size={15} className="text-amber-400 shrink-0" />
                  <span className="text-sm text-zinc-700 dark:text-slate-300 truncate flex-1">{folder.name}</span>
                  <ChevronRight size={13} className="text-zinc-300 shrink-0" />
                </button>
              ))}

              {/* Audio files */}
              {audioFiles.length > 0 && (
                <>
                  {audioFiles.length > 1 && (
                    <button
                      onClick={selectAll}
                      className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                    >
                      <div className="w-5 h-5 rounded border border-zinc-300 dark:border-slate-600 flex items-center justify-center bg-zinc-50 dark:bg-[#2d3148] shrink-0">
                        {audioFiles.every(f => selected.has(f.id)) && (
                          <Check size={12} className="text-brand-600" />
                        )}
                      </div>
                      <span className="text-xs text-zinc-500 dark:text-slate-400 italic">
                        {t('player.audioOnly' as any)} ({audioFiles.length})
                      </span>
                    </button>
                  )}
                  {audioFiles.map(file => (
                    <button
                      key={file.id}
                      onClick={() => toggleFile(file.id)}
                      className={cn(
                        'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
                        selected.has(file.id)
                          ? 'bg-brand-50 dark:bg-brand-900/20'
                          : 'hover:bg-zinc-50 dark:hover:bg-[#2d3148]',
                      )}
                    >
                      <div className={cn(
                        'w-5 h-5 rounded border flex items-center justify-center shrink-0 transition-colors',
                        selected.has(file.id)
                          ? 'border-brand-500 bg-brand-500'
                          : 'border-zinc-300 dark:border-slate-600 bg-white dark:bg-[#2d3148]',
                      )}>
                        {selected.has(file.id) && <Check size={12} className="text-white" />}
                      </div>
                      <Music size={13} className="text-brand-400 shrink-0" />
                      <span className="text-sm text-zinc-700 dark:text-slate-300 truncate">{file.name}</span>
                    </button>
                  ))}
                </>
              )}

              {/* Empty state — no audio files and no folders */}
              {folders.length === 0 && audioFiles.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 gap-2 text-sm text-zinc-400">
                  <Music size={28} className="text-zinc-200 dark:text-slate-700" />
                  <span>{t('player.noAudio' as any)}</span>
                </div>
              )}

              {/* Empty state — folders but no audio files */}
              {folders.length > 0 && audioFiles.length === 0 && (
                <div className="px-4 py-3 text-xs text-zinc-400 dark:text-slate-500 italic">
                  {t('player.noAudio' as any)}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-100 dark:border-[#2d3148] shrink-0">
          <span className="text-xs text-zinc-400">
            {selected.size > 0 ? `${selected.size} valgt` : ''}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-zinc-600 dark:text-slate-400 hover:text-zinc-900 dark:hover:text-slate-100 transition-colors"
            >
              {t('action.cancel' as any)}
            </button>
            <button
              onClick={confirm}
              disabled={selected.size === 0}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-sm font-medium transition-colors"
            >
              <Plus size={14} />
              {t('player.addSelected' as any)}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
