import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Archive, ArrowDown, ArrowLeft, ArrowUp, CheckSquare, EyeOff, Pin, Plus, Share2, Trash2, X } from 'lucide-react'
import { ApiClientError, api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { convertNoteToChecklist, createGuestItem, createNoteItem, deleteGuestItem, deleteNoteItem, getGuestNote, getNote, reorderGuestItems, reorderNoteItems, updateGuestItem, updateGuestNote, updateNote, updateNoteItem, type GuestNote, type Note, type NoteItem, type NoteUpdate } from '@/lib/notes'
import { NoteShareDialog } from '@/components/notes/NoteShareDialog'
import { NotesInstallButton } from '@/components/notes/NotesInstallButton'

type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict'

export function NoteEditor({ id, guest = false, includeDeleted = false }: Readonly<{ id: string; guest?: boolean; includeDeleted?: boolean }>) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Note | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [shareOpen, setShareOpen] = useState(false)
  const savedSignature = useRef('')
  const baseline = useRef<Note | null>(null)
  const dirtyItemIDs = useRef(new Set<string>())
  const pendingItemIDs = useRef(new Set<string>())
  const query = useQuery<Note | GuestNote>({
    queryKey: [guest ? 'guest-note' : 'note', id],
    queryFn: ({ signal }) => guest ? getGuestNote(id, signal) : getNote(id, includeDeleted, signal),
    refetchInterval: includeDeleted ? false : 2000,
  })
  const guestData = guest ? query.data as GuestNote | undefined : undefined
  const serverNote = guest ? guestData?.note : query.data as Note | undefined
  const permission = guestData?.permission ?? 'edit'
  const canEdit = permission === 'edit' && !includeDeleted
  const canCheck = (permission === 'check' || permission === 'edit') && !includeDeleted

  useEffect(() => {
    if (!serverNote) return
    const preserveNoteFields = Boolean(draft && baseline.current && signature(draft) !== signature(baseline.current))
    setDraft(current => mergeServerNote(serverNote, current, dirtyItemIDs.current, undefined, preserveNoteFields))
    baseline.current = serverNote
    savedSignature.current = signature(serverNote)
  }, [serverNote])

  const saveDraft = async (nextDraft: Note) => {
    setSaveState('saving')
    try {
      const update = changedNoteFields(nextDraft, baseline.current)
      if (Object.keys(update).length === 1) {
        setSaveState('saved')
        return
      }
      const saved = guest ? await updateGuestNote(id, update) : await updateNote(id, update)
      baseline.current = saved
      savedSignature.current = signature(saved)
      setDraft(current => mergeServerNote(saved, current, dirtyItemIDs.current, undefined, Boolean(current && signature(current) !== signature(nextDraft))))
      setSaveState('saved')
      queryClient.invalidateQueries({ queryKey: ['notes'] }).catch(() => undefined)
    } catch (error) {
      setSaveState(error instanceof ApiClientError && error.status === 409 ? 'conflict' : 'error')
      throw error
    }
  }
  const autoSaveDraft = useEffectEvent(saveDraft)

  useEffect(() => {
    if (!draft || !canEdit || signature(draft) === savedSignature.current) return
    const timeout = window.setTimeout(() => {
      autoSaveDraft(draft).catch(() => setSaveState('error'))
    }, 700)
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
    onSuccess: (note, variables) => {
      const preserveNoteFields = Boolean(draft && baseline.current && signature(draft) !== signature(baseline.current))
      if (variables.itemId) {
        dirtyItemIDs.current.delete(variables.itemId)
        pendingItemIDs.current.delete(variables.itemId)
      }
      baseline.current = note
      savedSignature.current = signature(note)
      setDraft(current => mergeServerNote(note, current, dirtyItemIDs.current, variables.itemId, preserveNoteFields))
      setSaveState('saved')
    },
    onError: (error, variables) => {
      if (variables.itemId) pendingItemIDs.current.delete(variables.itemId)
      setSaveState(error instanceof ApiClientError && error.status === 409 ? 'conflict' : 'error')
    },
  })

  if (query.isLoading || !draft) return <div className="mx-auto max-w-4xl py-16 text-center text-sm text-muted">{t('files.loading')}</div>
  if (query.isError) return <div className="mx-auto max-w-xl py-16 text-center"><h1 className="font-semibold">{t('notes.invalidInvite' as never)}</h1></div>

  const patchDraft = (patch: Partial<Note>) => setDraft(current => current ? { ...current, ...patch } : current)
  const addDraftItem = (position?: number) => setDraft(current => current ? insertDraftItem(current, position) : current)
  const commitItem = (item: NoteItem, position: number) => {
    const content = item.content.trim()
    if (isDraftItem(item)) {
      if (!content) {
        setDraft(current => current ? removeItem(current, item.id) : current)
        return
      }
      if (pendingItemIDs.current.has(item.id)) return
      pendingItemIDs.current.add(item.id)
      dirtyItemIDs.current.add(item.id)
      itemMutation.mutate({ action: 'create', itemId: item.id, content, position })
      return
    }
    if (pendingItemIDs.current.has(item.id)) return
    pendingItemIDs.current.add(item.id)
    dirtyItemIDs.current.add(item.id)
    itemMutation.mutate(content ? { action: 'update', itemId: item.id, content } : { action: 'delete', itemId: item.id })
  }
  const convertToChecklist = async () => {
    if (!draft || guest) return
    if (signature(draft) !== savedSignature.current) await saveDraft(draft)
    const converted = await convertNoteToChecklist(id)
    baseline.current = converted
    savedSignature.current = signature(converted)
    setDraft(converted)
    setSaveState('saved')
  }
  const moveItem = async (itemID: string, direction: -1 | 1) => {
    if (!draft || !canEdit) return
    const items = draft.items.filter(item => !isDraftItem(item))
    const index = items.findIndex(item => item.id === itemID)
    const target = index + direction
    if (index < 0 || target < 0 || target >= items.length) return
    ;[items[index], items[target]] = [items[target], items[index]]
    try {
      const itemIDs = items.map(item => item.id)
      const saved = guest ? await reorderGuestItems(id, draft.version, itemIDs) : await reorderNoteItems(id, draft.version, itemIDs)
      baseline.current = saved
      savedSignature.current = signature(saved)
      setDraft(current => mergeServerNote(saved, current, dirtyItemIDs.current))
    } catch { setSaveState('error') }
  }

  return (
    <section className="notes-editor mx-auto max-w-4xl animate-fade-in">
      <header className="mb-4 flex items-center justify-between gap-3 border-b border-zinc-200 pb-3 dark:border-zinc-800">
        <button className="notes-icon-button" title={t('action.close')} onClick={() => {
          if (guest) {
            history.back()
            return
          }
          navigate({ to: includeDeleted ? '/notes/trash' : '/notes' }).catch(() => undefined)
        }}><ArrowLeft size={19} /></button>
        <div className="flex items-center gap-1.5">
          <span className={`mr-2 text-xs ${saveState === 'error' || saveState === 'conflict' ? 'text-red-600' : 'text-muted'}`} aria-live="polite">{saveLabel(saveState, t)}</span>
          {!guest && !includeDeleted && <button className="notes-icon-button" title={t('notes.pinned' as never)} onClick={() => patchDraft({ is_pinned: !draft.is_pinned })}><Pin size={18} className={draft.is_pinned ? 'fill-brand-400 text-brand-600' : ''} /></button>}
          {!guest && !includeDeleted && <button className="notes-icon-button" title={t('notes.archive' as never)} onClick={() => patchDraft({ is_archived: !draft.is_archived })}><Archive size={18} /></button>}
          {!guest && !includeDeleted && <button className="notes-icon-button" title={t('action.share')} onClick={() => setShareOpen(true)}><Share2 size={18} /></button>}
        </div>
      </header>

      {guestData && <p className="mb-5 border-l-4 border-emerald-600 bg-emerald-50 px-4 py-3 text-sm text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100">{t('notes.guestAs' as never)}: <strong>{guestData.recipient_email}</strong></p>}
      {guest && <NotesInstallButton className="notes-secondary-button mb-5" />}
      {saveState === 'conflict' && <p className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950/30 dark:text-red-200">{t('notes.conflict' as never)}</p>}

      <p className="mb-3 text-xs text-muted">{lastEditedLabel(draft, t)}</p>

      <input aria-label={t('notes.noteTitle' as never)} value={draft.title} readOnly={!canEdit} maxLength={300} onChange={event => patchDraft({ title: event.target.value })} placeholder={t('notes.untitled' as never)} className="mb-4 w-full bg-transparent text-2xl font-semibold outline-none placeholder:text-zinc-400" />
      {draft.type === 'text' ? (
        <div>
          <textarea aria-label={t('notes.content' as never)} value={draft.content} readOnly={!canEdit} maxLength={100000} onChange={event => patchDraft({ content: event.target.value })} placeholder={t('notes.startWriting' as never)} className="min-h-[48vh] w-full resize-none bg-transparent text-base leading-7 outline-none" />
          {!guest && canEdit && <button className="notes-secondary-button mt-4" onClick={() => { convertToChecklist().catch(() => setSaveState('error')) }}><CheckSquare size={17} />{t('notes.addChecklist' as never)}</button>}
        </div>
      ) : (
        <div className="space-y-2">
          <label className="mb-4 flex w-fit items-center gap-2 text-sm text-muted"><input type="checkbox" checked={draft.hide_completed} disabled={!canEdit} onChange={event => patchDraft({ hide_completed: event.target.checked })} /><EyeOff size={15} />{t('notes.hideCompleted' as never)}</label>
          {draft.items.filter(item => !draft.hide_completed || !item.is_checked).map((item, index) => (
            <div key={item.id} className="group flex min-h-11 items-center gap-2 border-b border-zinc-100 dark:border-zinc-800">
              <label className="flex shrink-0 items-center"><span className="sr-only">{item.content}</span><input type="checkbox" checked={item.is_checked} disabled={!canCheck || isDraftItem(item) || pendingItemIDs.current.has(item.id)} onChange={event => { pendingItemIDs.current.add(item.id); dirtyItemIDs.current.add(item.id); itemMutation.mutate({ action: 'update', itemId: item.id, checked: event.target.checked }) }} className="size-5 accent-brand-600" /></label>
              <input value={item.content} readOnly={!canEdit} maxLength={2000} onChange={event => {
                if (!isDraftItem(item)) {
                  dirtyItemIDs.current.add(item.id)
                }
                setDraft(current => current ? updateItemContent(current, item.id, event.target.value) : current)
              }} onBlur={() => canEdit && commitItem(item, index)} onKeyDown={event => {
                if (event.key === 'Enter' && canEdit) { event.preventDefault(); commitItem(item, index); addDraftItem(index + 1) }
                if (event.key === 'Backspace' && item.content === '' && canEdit) {
                  if (isDraftItem(item)) setDraft(current => current ? removeItem(current, item.id) : current)
                  else itemMutation.mutate({ action: 'delete', itemId: item.id })
                }
              }} className={`min-w-0 flex-1 bg-transparent py-2 outline-none ${item.is_checked ? 'line-through opacity-55' : ''}`} />
              {canEdit && <div className="flex opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">{!isDraftItem(item) && <><button className="notes-icon-button" title={t('notes.moveUp' as never)} onClick={() => { moveItem(item.id, -1).catch(() => setSaveState('error')) }}><ArrowUp size={15} /></button><button className="notes-icon-button" title={t('notes.moveDown' as never)} onClick={() => { moveItem(item.id, 1).catch(() => setSaveState('error')) }}><ArrowDown size={15} /></button></>}<button className="notes-icon-button text-red-600" title={t('action.delete')} onClick={() => isDraftItem(item) ? setDraft(current => current ? removeItem(current, item.id) : current) : itemMutation.mutate({ action: 'delete', itemId: item.id })}><X size={16} /></button></div>}
            </div>
          ))}
      {canEdit && <button className="mt-4 flex items-center gap-2 text-sm font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400" onClick={() => addDraftItem()}><Plus size={17} />{t('notes.addItem' as never)}</button>}
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

function changedNoteFields(note: Note, previous: Note | null): NoteUpdate {
  const update: NoteUpdate = { version: note.version }
  if (note.title !== previous?.title) update.title = note.title
  if (note.content !== previous?.content) update.content = note.content
  if (note.is_pinned !== previous?.is_pinned) update.is_pinned = note.is_pinned
  if (note.is_archived !== previous?.is_archived) update.is_archived = note.is_archived
  if (note.hide_completed !== previous?.hide_completed) update.hide_completed = note.hide_completed
  return update
}

function mergeServerNote(server: Note, local: Note | null, dirtyItemIDs: Set<string>, completedItemID?: string, preserveNoteFields = false): Note {
  if (!local) return server
  const localByID = new Map(local.items.map(item => [item.id, item]))
  const items = server.items.map(item => dirtyItemIDs.has(item.id) ? localByID.get(item.id) ?? item : item)
  items.push(...local.items.filter(item => isDraftItem(item) && item.id !== completedItemID))
  return {
    ...server,
    ...(preserveNoteFields ? { title: local.title, content: local.content, is_pinned: local.is_pinned, is_archived: local.is_archived, hide_completed: local.hide_completed } : {}),
    items,
  }
}

function insertDraftItem(note: Note, requestedPosition = note.items.length): Note {
  const position = Math.max(0, Math.min(requestedPosition, note.items.length))
  const now = new Date().toISOString()
  const item: NoteItem = { id: `draft:${crypto.randomUUID()}`, note_id: note.id, content: '', is_checked: false, position, created_at: now, updated_at: now }
  const items = [...note.items]
  items.splice(position, 0, item)
  return { ...note, items }
}

function isDraftItem(item: NoteItem) {
  return item.id.startsWith('draft:')
}

function removeItem(note: Note, itemID: string): Note {
  return { ...note, items: note.items.filter(item => item.id !== itemID) }
}

function updateItemContent(note: Note, itemID: string, content: string): Note {
  return {
    ...note,
    items: note.items.map(item => item.id === itemID ? { ...item, content } : item),
  }
}

function lastEditedLabel(note: Note, t: ReturnType<typeof useI18n>['t']) {
  const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(note.updated_at))
  if (note.last_edited_by) return t('notes.lastEditedBy' as never, { name: note.last_edited_by, time })
  return t('notes.lastEdited' as never, { time })
}

function saveLabel(state: SaveState, t: ReturnType<typeof useI18n>['t']) {
  if (state === 'saving') return t('notes.saving' as never)
  if (state === 'saved') return t('notes.saved' as never)
  if (state === 'error') return t('notes.saveFailed' as never)
  if (state === 'conflict') return t('notes.conflictShort' as never)
  return ''
}
