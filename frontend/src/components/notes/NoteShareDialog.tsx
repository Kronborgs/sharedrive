import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, RefreshCw, ShieldX, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { listNoteShares, type Note, type NotePermission, type NoteShare } from '@/lib/notes'

export function NoteShareDialog({ note, onClose }: Readonly<{ note: Note; onClose: () => void }>) {
  const { t, locale } = useI18n()
  const queryClient = useQueryClient()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [email, setEmail] = useState('')
  const [permission, setPermission] = useState<NotePermission>('view')
  const [expiresAt, setExpiresAt] = useState('')
  const shares = useQuery({ queryKey: ['note-shares', note.id], queryFn: ({ signal }) => listNoteShares(note.id, signal) })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['note-shares', note.id] })
  const create = useMutation({
    mutationFn: () => api.post<NoteShare>(`/api/v1/notes/${note.id}/shares`, { recipient_email: email, permission, expires_at: expiresAt ? new Date(expiresAt).toISOString() : null, language: locale }),
    onSuccess: () => { setEmail(''); refresh(); toast.success(t('notes.invitationSent' as never)) },
    onError: () => toast.error(t('notes.invitationFailed' as never)),
  })
  const update = useMutation({
    mutationFn: ({ share, nextPermission }: { share: NoteShare; nextPermission: NotePermission }) => api.patch(`/api/v1/notes/${note.id}/shares/${share.id}`, { permission: nextPermission, expires_at: share.expires_at ?? null }),
    onSuccess: refresh,
    onError: () => toast.error(t('notes.actionFailed' as never)),
  })
  const revoke = useMutation({
    mutationFn: (share: NoteShare) => api.delete(`/api/v1/notes/${note.id}/shares/${share.id}`),
    onSuccess: refresh,
    onError: () => toast.error(t('notes.actionFailed' as never)),
  })
  const resend = useMutation({
    mutationFn: (share: NoteShare) => api.post(`/api/v1/notes/${note.id}/shares/${share.id}/resend`),
    onSuccess: () => { refresh(); toast.success(t('notes.invitationSent' as never)) },
    onError: () => toast.error(t('notes.invitationFailed' as never)),
  })

  useEffect(() => {
    closeRef.current?.focus()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section role="dialog" aria-modal="true" aria-labelledby="note-share-title" className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-lg bg-white p-5 shadow-2xl dark:bg-[#1a1d27] sm:rounded-lg">
        <header className="mb-5 flex items-center justify-between">
          <div><h2 id="note-share-title" className="font-semibold">{t('notes.shareNote' as never)}</h2><p className="mt-1 max-w-md truncate text-xs text-muted">{note.title || t('notes.untitled' as never)}</p></div>
          <button ref={closeRef} className="notes-icon-button" onClick={onClose} title={t('action.close')}><X size={18} /></button>
        </header>

        <form className="grid gap-3 border-b border-zinc-200 pb-5 dark:border-zinc-800 sm:grid-cols-[1fr_150px]" onSubmit={event => { event.preventDefault(); create.mutate() }}>
          <label className="sm:col-span-2"><span className="mb-1 block text-xs font-medium">{t('shared.recipientEmail')}</span><input required type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="recipient@example.com" className="notes-input" /></label>
          <label><span className="mb-1 block text-xs font-medium">{t('notes.permission' as never)}</span><select value={permission} onChange={event => setPermission(event.target.value as NotePermission)} className="notes-input"><option value="view">{t('notes.canView' as never)}</option>{note.type === 'checklist' && <option value="check">{t('notes.canCheck' as never)}</option>}<option value="edit">{t('notes.canEdit' as never)}</option></select></label>
          <label><span className="mb-1 block text-xs font-medium">{t('notes.expires' as never)}</span><input type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} className="notes-input" /></label>
          <button disabled={create.isPending} className="notes-primary-button sm:col-span-2 sm:w-fit" type="submit"><Mail size={16} />{t('notes.sendInvitation' as never)}</button>
        </form>

        <div className="pt-5">
          <h3 className="mb-3 text-sm font-semibold">{t('notes.activeInvitations' as never)}</h3>
          {(shares.data ?? []).filter(share => !share.revoked_at).length === 0 && <p className="text-sm text-muted">{t('notes.noInvitations' as never)}</p>}
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {(shares.data ?? []).filter(share => !share.revoked_at).map(share => (
              <li key={share.id} className="py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0"><p className="truncate text-sm font-medium">{share.recipient_email}</p><p className="text-xs text-muted">{share.expires_at ? `${t('notes.expires' as never)} ${new Date(share.expires_at).toLocaleString()}` : t('notes.noExpiry' as never)}</p></div>
                  <div className="flex items-center gap-1">
                    <select aria-label={t('notes.permission' as never)} value={share.permission} onChange={event => update.mutate({ share, nextPermission: event.target.value as NotePermission })} className="rounded-md border bg-transparent px-2 py-1.5 text-xs"><option value="view">{t('notes.canView' as never)}</option>{note.type === 'checklist' && <option value="check">{t('notes.canCheck' as never)}</option>}<option value="edit">{t('notes.canEdit' as never)}</option></select>
                    <button className="notes-icon-button" title={t('notes.resend' as never)} onClick={() => resend.mutate(share)}><RefreshCw size={15} /></button>
                    <button className="notes-icon-button text-red-600" title={t('notes.revoke' as never)} onClick={() => revoke.mutate(share)}><ShieldX size={15} /></button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  )
}