import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DoorOpen, Image, Trash2, Upload, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

interface RoomAccount {
  id: string
  email: string
  display_name: string
  account_type: 'sharedrive' | 'rooms_only'
  access_enabled: boolean
  room_count: number
}

interface AdminRoomsOverview {
  accounts: RoomAccount[]
}

interface GIFLibraryItem {
  id: string
  file_id: string
  title: string
  category?: string
  name: string
  mime_type: string
}

function EmptyRow({ children }: Readonly<{ children: string }>) {
  return <div className="rounded-lg border border-zinc-200 px-4 py-5 text-sm text-zinc-500 dark:border-[#2d3148] dark:text-slate-400">{children}</div>
}

function AccountRow({ account, onToggle, pending }: Readonly<{ account: RoomAccount; onToggle: (account: RoomAccount) => void; pending: boolean }>) {
  const { t } = useI18n()
  return <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-[#2d3148] dark:bg-[#1a1d27]">
    <UserRound size={18} className="text-brand-600" />
    <div className="min-w-48 flex-1"><p className="text-sm font-medium text-zinc-900 dark:text-slate-100">{account.display_name || account.email}</p><p className="text-xs text-zinc-500 dark:text-slate-400">{account.email}</p></div>
    <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-700 dark:bg-[#272b3a] dark:text-slate-300">{t(account.account_type === 'rooms_only' ? 'rooms.onlyRooms' : 'rooms.sharedriveRooms')}</span>
    <span className="w-20 text-right text-xs text-zinc-500 dark:text-slate-400">{t(account.room_count === 1 ? 'rooms.roomCount' : 'rooms.roomsCount', { count: account.room_count })}</span>
    <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-slate-300"><input type="checkbox" checked={account.access_enabled} disabled={pending} onChange={() => onToggle(account)} className="accent-brand-600" /> {t('rooms.access')}</label>
  </div>
}

function AdminGIFLibrary() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('')
  const queryKey = ['admin', 'rooms-gifs']
  const library = useQuery({ queryKey, queryFn: ({ signal }) => api.get<{ items: GIFLibraryItem[] }>('/api/v1/admin/rooms/gifs', signal) })
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.type !== 'image/gif' && file.type !== 'image/webp') throw new Error('unsupported gif type')
      const formData = new FormData()
      formData.append('file', file)
      const created = await api.post<{ id: string }>('/api/v1/files/upload', formData)
      return api.post('/api/v1/admin/rooms/gifs', { file_id: created.id, title: title.trim(), category: category.trim(), search_terms: `${title} ${category}`.trim() })
    },
    onSuccess: () => { setTitle(''); setCategory(''); queryClient.invalidateQueries({ queryKey }).catch(() => undefined); toast.success(t('rooms.gifAdded')) },
    onError: () => toast.error(t('rooms.gifAddFailed')),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/admin/rooms/gifs/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: () => toast.error(t('rooms.gifRemoveFailed')),
  })
  const selectFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) upload.mutate(file)
    event.currentTarget.value = ''
  }
  return <section>
    <h2 className="mb-1 flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-slate-100"><Image size={18} /> {t('rooms.gifLibrary')}</h2>
    <p className="mb-3 text-sm text-zinc-500 dark:text-slate-400">{t('rooms.gifLibraryDescription')}</p>
    <div className="mb-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-[#2d3148] dark:bg-[#1a1d27]">
      <div className="grid gap-2 sm:grid-cols-2"><input value={title} onChange={event => setTitle(event.target.value)} placeholder={t('rooms.gifTitle')} className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-[#34394f] dark:bg-[#11141e]" /><input value={category} onChange={event => setCategory(event.target.value)} placeholder={t('rooms.gifCategory')} className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-[#34394f] dark:bg-[#11141e]" /></div>
      <input ref={inputRef} type="file" accept="image/gif,image/webp" className="sr-only" onChange={selectFile} disabled={upload.isPending} />
      <button type="button" onClick={() => inputRef.current?.click()} disabled={upload.isPending} className="mt-2 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"><Upload size={16} /> {upload.isPending ? t('rooms.uploading') : t('rooms.gifUpload')}</button>
    </div>
    {library.isLoading ? <p className="text-sm text-muted">{t('rooms.gifLoading')}</p> : <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">{(library.data?.items ?? []).map(item => <article key={item.id} className="group relative overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-[#2d3148] dark:bg-[#1a1d27]"><img src={`/api/v1/files/${item.file_id}/${item.mime_type === 'image/gif' ? 'preview' : 'thumbnail'}`} alt={item.title || item.name} className="aspect-video w-full object-cover" /><div className="truncate px-2 py-1.5 text-xs">{item.title || item.name}</div><button type="button" onClick={() => { if (window.confirm(t('rooms.gifRemoveConfirm', { name: item.title || item.name }))) remove.mutate(item.id) }} className="absolute right-1 top-1 rounded-full bg-black/70 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100" aria-label={t('rooms.gifRemove')}><Trash2 size={14} /></button></article>)}</div>}
  </section>
}

export function AdminRoomsAccessPanel() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const queryKey = ['admin', 'rooms-access']
  const overview = useQuery({ queryKey, queryFn: ({ signal }) => api.get<AdminRoomsOverview>('/api/v1/admin/rooms/access', signal) })
  const updateAccess = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/api/v1/admin/rooms/users/${id}/access`, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: () => toast.error(t('rooms.accessUpdateFailed')),
  })
  if (overview.isLoading) return <p className="py-8 text-center text-sm text-zinc-500 dark:text-slate-400">{t('rooms.adminLoading')}</p>
  if (!overview.data) return <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">{t('rooms.adminLoadFailed')}</p>
  const { accounts, pending_invitations = [], guests = [] } = overview.data
  return <div className="space-y-8">
    <section><h2 className="mb-1 flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-slate-100"><DoorOpen size={18} /> {t('rooms.adminUsers')}</h2><p className="mb-3 text-sm text-zinc-500 dark:text-slate-400">{t('rooms.adminUsersDescription')}</p><div className="space-y-2">{accounts.length ? accounts.map(account => <AccountRow key={account.id} account={account} pending={updateAccess.isPending} onToggle={item => updateAccess.mutate({ id: item.id, enabled: !item.access_enabled })} />) : <EmptyRow>{t('rooms.noAdminUsers')}</EmptyRow>}</div></section>
    <section><h2 className="mb-1 text-base font-semibold text-zinc-900 dark:text-slate-100">Afventende invitationer</h2><div className="space-y-2">{pending_invitations.length ? pending_invitations.map(inv => <div key={inv.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-[#2d3148] dark:bg-[#1a1d27]"><div className="min-w-48 flex-1"><p className="text-sm font-medium">{inv.email}</p><p className="text-xs text-muted">{inv.room_name} · {inv.role} · udløber {new Date(inv.expires_at).toLocaleDateString()}</p></div><button type="button" onClick={() => { if (confirm('Tilbagekald invitationen?')) void api.delete(`/api/v1/admin/rooms/invitations/${inv.id}`).then(() => queryClient.invalidateQueries({ queryKey })).catch(() => toast.error('Invitationen kunne ikke tilbagekaldes')) }} className="rounded-lg border border-red-200 px-2.5 py-1.5 text-xs text-red-600">Tilbagekald</button></div>) : <EmptyRow>Ingen afventende invitationer.</EmptyRow>}</div></section>
    <section><h2 className="mb-1 text-base font-semibold text-zinc-900 dark:text-slate-100">Aktive gæster</h2><div className="space-y-2">{guests.length ? guests.map(guest => <div key={guest.session_id} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-[#2d3148] dark:bg-[#1a1d27]"><div className="min-w-48 flex-1"><p className="text-sm font-medium">{guest.display_name}</p><p className="text-xs text-muted">{guest.room_name} · {guest.invitation} · udløber {new Date(guest.expires_at).toLocaleDateString()}</p><p className="text-xs text-muted">Sidst aktiv: {guest.last_accessed_at ? new Date(guest.last_accessed_at).toLocaleString() : 'aldrig'}</p></div><button type="button" onClick={() => { if (confirm('Tilbagekald gæsteadgangen?')) void api.delete(`/api/v1/admin/rooms/guests/${guest.session_id}`).then(() => queryClient.invalidateQueries({ queryKey })).catch(() => toast.error('Gæsteadgangen kunne ikke tilbagekaldes')) }} className="rounded-lg border border-red-200 px-2.5 py-1.5 text-xs text-red-600">Tilbagekald</button></div>) : <EmptyRow>Ingen aktive gæster.</EmptyRow>}</div></section>
    <AdminGIFLibrary />
  </div>
}
