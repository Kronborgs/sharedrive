import { useDeferredValue, useEffect, useEffectEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Archive, CheckSquare, FileText, Pin, Plus, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'
import { api } from '@/lib/api'
import { createNote, listNotes, type Note, type NoteType } from '@/lib/notes'

type NotesView = 'active' | 'archive' | 'trash'

export function NotesPage({ view = 'active' }: Readonly<{ view?: NotesView }>) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const params = new URLSearchParams()
  if (deferredSearch) params.set('search', deferredSearch)
  if (view === 'archive') params.set('archived', 'true')
  if (view === 'trash') params.set('deleted', 'true')

  const notesQuery = useQuery({
    queryKey: ['notes', view, deferredSearch],
    queryFn: ({ signal }) => listNotes(params, signal),
  })
  const createMutation = useMutation({
    mutationFn: (type: NoteType) => createNote(type),
    onSuccess: note => void navigate({ to: '/notes/$id', params: { id: note.id } }),
    onError: () => toast.error(t('notes.createFailed' as never)),
  })
  const runShortcut = useEffectEvent((type: NoteType) => createMutation.mutate(type))
  useEffect(() => {
    const requestedType = new URLSearchParams(window.location.search).get('new')
    if (requestedType !== 'text' && requestedType !== 'checklist') return
    window.history.replaceState({}, '', window.location.pathname)
    runShortcut(requestedType)
  }, [])
  const noteAction = useMutation({
    mutationFn: ({ note, action }: { note: Note; action: 'restore' | 'delete' }) =>
      action === 'restore'
        ? api.post(`/api/v1/notes/${note.id}/restore`)
        : api.delete(`/api/v1/notes/${note.id}${view === 'trash' ? '/permanent' : ''}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notes'] }),
    onError: () => toast.error(t('notes.actionFailed' as never)),
  })

  const title = view === 'archive' ? t('notes.archive' as never) : view === 'trash' ? t('notes.trash' as never) : t('notes.title' as never)
  const notes = notesQuery.data ?? []

  return (
    <section className="mx-auto max-w-7xl animate-fade-in" aria-labelledby="notes-heading">
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 id="notes-heading" className="text-2xl font-semibold text-zinc-950 dark:text-white">{title}</h1>
          <div className="mt-2 flex gap-1 text-sm">
            <NotesTab href="/notes" active={view === 'active'} label={t('notes.all' as never)} icon={<FileText size={15} />} />
            <NotesTab href="/notes/archive" active={view === 'archive'} label={t('notes.archive' as never)} icon={<Archive size={15} />} />
            <NotesTab href="/notes/trash" active={view === 'trash'} label={t('notes.trash' as never)} icon={<Trash2 size={15} />} />
          </div>
        </div>
        {view === 'active' && (
          <div className="flex flex-wrap gap-2">
            <button className="notes-primary-button" onClick={() => createMutation.mutate('text')} disabled={createMutation.isPending}>
              <Plus size={17} /> {t('notes.newNote' as never)}
            </button>
            <button className="notes-secondary-button" onClick={() => createMutation.mutate('checklist')} disabled={createMutation.isPending}>
              <CheckSquare size={17} /> {t('notes.newChecklist' as never)}
            </button>
          </div>
        )}
      </header>

      <label className="mb-6 flex max-w-xl items-center gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 shadow-sm focus-within:border-amber-500 dark:border-[#2d3148] dark:bg-[#1a1d27]">
        <Search size={18} className="text-zinc-400" />
        <span className="sr-only">{t('notes.search' as never)}</span>
        <input value={search} onChange={event => setSearch(event.target.value)} placeholder={t('notes.search' as never)} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </label>

      {notesQuery.isLoading && <p className="text-sm text-muted">{t('files.loading')}</p>}
      {!notesQuery.isLoading && notes.length === 0 && (
        <div className="border-y border-dashed border-zinc-300 py-16 text-center dark:border-zinc-700">
          <FileText className="mx-auto mb-3 text-amber-500" size={30} />
          <p className="text-sm text-muted">{t('notes.empty' as never)}</p>
        </div>
      )}
      <div className="notes-grid">
        {notes.map(note => (
          <article key={note.id} className="notes-card" style={{ borderTopColor: note.color || (note.type === 'checklist' ? '#4d8c68' : '#d89a2b') }}>
            <button className="min-h-32 w-full text-left" onClick={() => void navigate({ to: '/notes/$id', params: { id: note.id }, search: view === 'trash' ? { deleted: true } : {} })}>
              <div className="mb-3 flex items-start justify-between gap-3">
                <h2 className="line-clamp-2 font-semibold text-zinc-900 dark:text-zinc-100">{note.title || t('notes.untitled' as never)}</h2>
                {note.is_pinned && <Pin size={15} className="shrink-0 fill-amber-400 text-amber-600" aria-label={t('notes.pinned' as never)} />}
              </div>
              {note.type === 'text' ? (
                <p className="line-clamp-5 whitespace-pre-wrap text-sm leading-6 text-zinc-600 dark:text-slate-300">{note.content}</p>
              ) : (
                <ul className="space-y-1.5 text-sm text-zinc-600 dark:text-slate-300">
                  {note.items.slice(0, 5).map(item => <li key={item.id} className={item.is_checked ? 'line-through opacity-60' : ''}>□ {item.content}</li>)}
                </ul>
              )}
            </button>
            <footer className="mt-4 flex items-center justify-between border-t border-zinc-100 pt-3 text-xs text-muted dark:border-zinc-800">
              <time dateTime={note.updated_at}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(note.updated_at))}</time>
              <div className="flex gap-1">
                {view === 'trash' && <button className="notes-icon-button" title={t('action.restore')} onClick={() => noteAction.mutate({ note, action: 'restore' })}><Archive size={15} /></button>}
                <button className="notes-icon-button text-red-600" title={view === 'trash' ? t('ctx.delete') : t('ctx.trash')} onClick={() => noteAction.mutate({ note, action: 'delete' })}><Trash2 size={15} /></button>
              </div>
            </footer>
          </article>
        ))}
      </div>
    </section>
  )
}

function NotesTab({ href, active, label, icon }: Readonly<{ href: string; active: boolean; label: string; icon: React.ReactNode }>) {
  return <a href={href} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 ${active ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'text-muted hover:bg-zinc-200/60 dark:hover:bg-zinc-800'}`}>{icon}{label}</a>
}