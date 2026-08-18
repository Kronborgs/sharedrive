import * as Dialog from '@radix-ui/react-dialog'
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { DoorOpen, PhoneCall, Plus, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'
import { createRoom, listRooms, type Room } from '@/lib/rooms'

function roomTimestamp(updatedAt: string, locale: string) {
  return new Intl.DateTimeFormat(locale === 'da' ? 'da-DK' : 'en-US', { hour: '2-digit', minute: '2-digit' }).format(new Date(updatedAt))
}

function RoomConversationRow({ room, activeRoomID, locale }: Readonly<{ room: Room; activeRoomID?: string; locale: string }>) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const isActive = room.id === activeRoomID || room.slug === activeRoomID
  const activeClass = isActive ? 'bg-brand-50 dark:bg-brand-900/30' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'

  return <button type="button" onClick={() => navigate({ to: '/rooms/$roomID', params: { roomID: room.slug } }).catch(() => undefined)} className={`w-full rounded-lg p-3 text-left transition-colors ${activeClass}`} aria-current={isActive ? 'page' : undefined}>
    <span className="flex items-start gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface text-brand-600"><DoorOpen size={18} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{room.name}</span><time dateTime={room.updated_at} className="shrink-0 text-xs text-muted">{roomTimestamp(room.updated_at, locale)}</time></span>
        <span className="mt-1 flex items-center justify-between gap-2 text-xs text-muted">
          {room.voice_active ? <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><PhoneCall size={13} /> {t('rooms.voiceActive')}</span> : <span>{t(`rooms.role.${room.current_role}` as never)}</span>}
          {room.unread_count > 0 && <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-[11px] font-semibold text-white" aria-label={t('rooms.unreadMessages', { count: room.unread_count })}>{room.unread_count > 99 ? '99+' : room.unread_count}</span>}
        </span>
      </span>
    </span>
  </button>
}

export function RoomConversationSidebar({ activeRoomID }: Readonly<{ activeRoomID?: string }>) {
  const { t, locale } = useI18n()
  const [query, setQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [roomName, setRoomName] = useState('')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const roomsQuery = useQuery({ queryKey: ['rooms'], queryFn: ({ signal }) => listRooms(signal), refetchInterval: 5_000, refetchIntervalInBackground: true })
  const normalizedQuery = query.trim().toLocaleLowerCase(locale === 'da' ? 'da-DK' : 'en-US')
  const rooms = useMemo(() => (roomsQuery.data ?? []).filter(room => room.name.toLocaleLowerCase(locale === 'da' ? 'da-DK' : 'en-US').includes(normalizedQuery)), [locale, normalizedQuery, roomsQuery.data])
  const createMutation = useMutation({
    mutationFn: () => createRoom(roomName),
    onSuccess: room => {
      setDialogOpen(false)
      setRoomName('')
      queryClient.invalidateQueries({ queryKey: ['rooms'] }).catch(() => undefined)
      navigate({ to: '/rooms/$roomID', params: { roomID: room.slug } }).catch(() => undefined)
    },
    onError: () => toast.error(t('rooms.createFailed' as never)),
  })

  return <aside className="hidden min-h-0 pr-3 lg:flex lg:w-60 lg:shrink-0 lg:flex-col xl:w-72" aria-label={t('rooms.conversations' as never)}>
    <label className="relative mb-3 block"><span className="sr-only">{t('rooms.searchConversations' as never)}</span><Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('rooms.searchConversations' as never)} className="notes-input w-full pl-9" /></label>
    <h2 className="mb-2 px-2 text-sm font-semibold">{t('rooms.conversations' as never)}</h2>
    <div className="min-h-0 space-y-1 overflow-y-auto pb-3">
      {rooms.map(room => <RoomConversationRow key={room.id} room={room} activeRoomID={activeRoomID} locale={locale} />)}
      {!roomsQuery.isLoading && rooms.length === 0 && <p className="px-2 py-4 text-sm text-muted">{t('rooms.noMatchingRooms' as never)}</p>}
    </div>
    <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
      <Dialog.Trigger asChild><button type="button" className="notes-secondary-button mt-auto w-full"><Plus size={17} /> {t('rooms.create' as never)}</button></Dialog.Trigger>
      <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-subtle bg-surface p-5 shadow-xl"><div className="flex items-start justify-between gap-4"><div><Dialog.Title className="text-lg font-semibold">{t('rooms.create' as never)}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted">{t('rooms.createDescription' as never)}</Dialog.Description></div><Dialog.Close asChild><button type="button" className="notes-icon-button" aria-label={t('action.close')}><X size={17} /></button></Dialog.Close></div><form className="mt-5" onSubmit={event => { event.preventDefault(); createMutation.mutate() }}><label className="block text-sm font-medium" htmlFor="sidebar-room-name">{t('rooms.name' as never)}<input id="sidebar-room-name" autoFocus required maxLength={120} value={roomName} onChange={event => setRoomName(event.target.value)} placeholder={t('rooms.namePlaceholder' as never)} className="notes-input mt-2 w-full" /></label><div className="mt-5 flex justify-end gap-2"><Dialog.Close asChild><button type="button" className="notes-secondary-button">{t('action.cancel')}</button></Dialog.Close><button type="submit" className="notes-primary-button" disabled={createMutation.isPending || !roomName.trim()}>{t('rooms.create' as never)}</button></div></form></Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </aside>
}
