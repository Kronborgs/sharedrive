import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Archive, ArrowDown, ArrowLeft, ArrowUp, Check, EyeOff, Pin, Plus, Share2, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiClientError, api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { createGuestItem, createNoteItem, deleteGuestItem, deleteNoteItem, getGuestNote, getNote, reorderGuestItems, reorderNoteItems, updateGuestItem, updateGuestNote, updateNote, updateNoteItem, type GuestNote, type Note } from '@/lib/notes'
import { NoteShareDialog } from '@/components/notes/NoteShareDialog'

type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict'

export function NoteEditor({ id, guest = false, includeDeleted = false }: Readonly<{ id: string; guest?: boolean; includeDeleted?: boolean }>) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Note | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [shareOpen, setShareOpen] = useState(false)
  const savedSignature = useRef('')
  const query = useQuery({
    queryKey: [guest ? 'guest-note' : 'note', id],
    queryFn: ({ signal }) => guest ? getGuestNote(id, signal) : getNote(id, includeDeleted, signal),
  })
  const guestData = guest ? query.data as GuestNote | undefined : undefined
  const serverNote = guest ? guestData?.note : query.data as Note | undefined
  const permission = guestData?.permission ?? 'edit'
  const canEdit = permission === 'edit' && !includeDeleted
  const canCheck = (permission === 'check' || permission === 'edit') && !includeDeleted

  useEffect(() => {
    if (!serverNote) return
    setDraft(serverNote)
    savedSignature.current = signature(serverNote)
  }, [serverNote])

  const saveDraft = useEffectEvent(async (nextDraft: Note) => {
    setSaveState('saving')
    try {
      const update = { version: nextDraft.version, title: nextDraft.title, content: nextDraft.content, is_pinned: nextDraft.is_pinned, is_archived: nextDraft.is_archived, hide_completed: nextDraft.hide_completed }
      const saved = guest ? await updateGuestNote(id, update) : await updateNote(id, update)
      savedSignature.current = signature(saved)
      setDraft(saved)
      setSaveState('saved')
      void queryClient.invalidateQueries({ queryKey: ['notes'] })
    } catch (error) {
      setSaveState(error instanceof ApiClientError && error.status === 409 ? 'conflict' : 'error')
    }
  })

  useEffect(() => {
    if (!draft || !canEdit || signature(draft) === savedSignature.current) return
    const timeout = window.setTimeout(() => void saveDraft(draft), 700)
    return () => window.clearTimeout(timeout)
  }, [draft, canEdit])

  const itemMutation = useMutation({
    mutationFn: async ({ action, itemId, content, checked, position }: { action: 'create' | 'update' | 'delete'; itemId?: string; content?: string; checked?: boolean; position?: number }) => {
      if (!draft) throw new Error('note unavailable')
      if (guest) {
    if (action === 'create') return createGuestItem(id, draft.version, content, position)
    if (action === 'delete' && itemId) return deleteGuestItem(id, itemId, draft.version)
    if (itemId) return updateGuestItem(id, itemId, { version: draft.version, content, is_checked: checked })
    throw new Error('guest operation unavailable')
      }
      if (action === 'create') return createNoteItem(id, draft.version, content, position)
      if (action === 'delete' && itemId) return deleteNoteItem(id, itemId, draft.version)
      if (itemId) return updateNoteItem(id, itemId, { version: draft.version, content, is_checked: checked })
      throw new Error('invalid item operation')
    },
    onSuccess: note => { setDraft(note); savedSignature.current = signature(note); setSaveState('saved') },
    onError: error => setSaveState(error instanceof ApiClientError && error.status === 409 ? 'conflict' : 'error'),
  })

  if (query.isLoading || !draft) return <div className="mx-auto max-w-4xl py-16 text-center text-sm text-muted">{t('files.loading')}</div>
  if (query.isError) return <div className="mx-auto max-w-xl py-16 text-center"><h1 className="font-semibold">{t('notes.invalidInvite' as never)}</h1></div>

  const patchDraft = (patch: Partial<Note>) => setDraft(current => current ? { ...current, ...patch } : current)
  const moveItem = async (index: number, direction: -1 | 1) => {
  	if (!draft || !canEdit) return
    const target = index + direction
    if (target < 0 || target >= draft.items.length) return
    const items = [...draft.items]
    ;[items[index], items[target]] = [items[target], items[index]]
    try {
      const itemIDs = items.map(item => item.id)
      const saved = guest ? await reorderGuestItems(id, draft.version, itemIDs) : await reorderNoteItems(id, draft.version, itemIDs)
      setDraft(saved); savedSignature.current = signature(saved)
    } catch { setSaveState('error') }
  }

  return (
    <section className="notes-editor mx-auto max-w-4xl animate-fade-in">
      <header className="mb-4 flex items-center justify-between gap-3 border-b border-zinc-200 pb-3 dark:border-zinc-800">
        <button className="notes-icon-button" title={t('action.close')} onClick={() => guest ? history.back() : void navigate({ to: includeDeleted ? '/notes/trash' : '/notes' })}><ArrowLeft size={19} /></button>
        <div className="flex items-center gap-1.5">
          <span className={`mr-2 text-xs ${saveState === 'error' || saveState === 'conflict' ? 'text-red-600' : 'text-muted'}`} aria-live="polite">{saveLabel(saveState, t)}</span>
          {!guest && !includeDeleted && <button className="notes-icon-button" title={t('notes.pinned' as never)} onClick={() => patchDraft({ is_pinned: !draft.is_pinned })}><Pin size={18} className={draft.is_pinned ? 'fill-amber-400 text-amber-600' : ''} /></button>}
          {!guest && !includeDeleted && <button className="notes-icon-button" title={t('notes.archive' as never)} onClick={() => patchDraft({ is_archived: !draft.is_archived })}><Archive size={18} /></button>}
          {!guest && !includeDeleted && <button className="notes-icon-button" title={t('action.share')} onClick={() => setShareOpen(true)}><Share2 size={18} /></button>}
        </div>
      </header>

      {guestData && <p className="mb-5 border-l-4 border-emerald-600 bg-emerald-50 px-4 py-3 text-sm text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100">{t('notes.guestAs' as never)}: <strong>{guestData.recipient_email}</strong></p>}
      {saveState === 'conflict' && <p className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950/30 dark:text-red-200">{t('notes.conflict' as never)}</p>}

      <input aria-label={t('notes.noteTitle' as never)} value={draft.title} readOnly={!canEdit} maxLength={300} onChange={event => patchDraft({ title: event.target.value })} placeholder={t('notes.untitled' as never)} className="mb-4 w-full bg-transparent text-2xl font-semibold outline-none placeholder:text-zinc-400" />
      {draft.type === 'text' ? (
        <textarea aria-label={t('notes.content' as never)} value={draft.content} readOnly={!canEdit} maxLength={100000} onChange={event => patchDraft({ content: event.target.value })} placeholder={t('notes.startWriting' as never)} className="min-h-[55vh] w-full resize-none bg-transparent text-base leading-7 outline-none" />
      ) : (
        <div className="space-y-2">
          <label className="mb-4 flex w-fit items-center gap-2 text-sm text-muted"><input type="checkbox" checked={draft.hide_completed} disabled={!canEdit} onChange={event => patchDraft({ hide_completed: event.target.checked })} /><EyeOff size={15} />{t('notes.hideCompleted' as never)}</label>
          {draft.items.filter(item => !draft.hide_completed || !item.is_checked).map((item, index) => (
            <div key={item.id} className="group flex min-h-11 items-center gap-2 border-b border-zinc-100 dark:border-zinc-800">
              <label className="flex shrink-0 items-center"><span className="sr-only">{item.content}</span><input type="checkbox" checked={item.is_checked} disabled={!canCheck} onChange={event => itemMutation.mutate({ action: 'update', itemId: item.id, checked: event.target.checked })} className="size-5 accent-emerald-700" /></label>
              <input value={item.content} readOnly={!canEdit} maxLength={2000} onChange={event => setDraft(current => current ? { ...current, items: current.items.map(candidate => candidate.id === item.id ? { ...candidate, content: event.target.value } : candidate) } : current)} onBlur={() => canEdit && itemMutation.mutate({ action: 'update', itemId: item.id, content: item.content })} onKeyDown={event => {
                if (event.key === 'Enter' && canEdit) { event.preventDefault(); itemMutation.mutate({ action: 'create', content: '', position: index + 1 }) }
                if (event.key === 'Backspace' && item.content === '' && canEdit) itemMutation.mutate({ action: 'delete', itemId: item.id })
              }} className={`min-w-0 flex-1 bg-transparent py-2 outline-none ${item.is_checked ? 'line-through opacity-55' : ''}`} />
              {canEdit && <div className="flex opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"><button className="notes-icon-button" title={t('notes.moveUp' as never)} onClick={() => void moveItem(index, -1)}><ArrowUp size={15} /></button><button className="notes-icon-button" title={t('notes.moveDown' as never)} onClick={() => void moveItem(index, 1)}><ArrowDown size={15} /></button><button className="notes-icon-button text-red-600" title={t('action.delete')} onClick={() => itemMutation.mutate({ action: 'delete', itemId: item.id })}><X size={16} /></button></div>}
            </div>
          ))}
		  {canEdit && <button className="mt-4 flex items-center gap-2 text-sm font-medium text-emerald-700 hover:text-emerald-900 dark:text-emerald-400" onClick={() => itemMutation.mutate({ action: 'create', content: '' })}><Plus size={17} />{t('notes.addItem' as never)}</button>}
        </div>
      )}

      {guest && <button className="mt-10 flex items-center gap-2 text-sm text-red-600" onClick={async () => { await api.post('/api/v1/guest/logout'); location.assign('/') }}><Trash2 size={16} />{t('notes.closeGuest' as never)}</button>}
      {shareOpen && <NoteShareDialog note={draft} onClose={() => setShareOpen(false)} />}
    </section>
  )
}

function signature(note: Note) {
  return JSON.stringify([note.title, note.content, note.is_pinned, note.is_archived, note.hide_completed])
}

function saveLabel(state: SaveState, t: ReturnType<typeof useI18n>['t']) {
  if (state === 'saving') return t('notes.saving' as never)
  if (state === 'saved') return t('notes.saved' as never)
  if (state === 'error') return t('notes.saveFailed' as never)
  if (state === 'conflict') return t('notes.conflictShort' as never)
  return ''
}

void Check