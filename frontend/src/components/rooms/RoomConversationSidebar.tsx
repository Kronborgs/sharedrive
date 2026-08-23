import * as Dialog from '@radix-ui/react-dialog'
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDown, DoorOpen, MailPlus, MessageCircle, PhoneCall, Plus, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'
import { createRoom, listDirectConversations, listRooms, startPrivateChatByEmail, type DirectConversation, type Room } from '@/lib/rooms'

type ConversationFilter = 'all' | 'rooms' | 'direct' | 'unread'

function ConversationFilters({ value, onChange }: Readonly<{ value: ConversationFilter; onChange: (filter: ConversationFilter) => void }>) {
  const { t } = useI18n()
  const filters: Array<{ id: ConversationFilter; label: string }> = [
    { id: 'all', label: t('rooms.filterAll') },
    { id: 'rooms', label: t('rooms.filterRooms') },
    { id: 'direct', label: t('rooms.direct') },
    { id: 'unread', label: t('rooms.filterUnread') },
  ]
  return <div className="mb-3 flex gap-1 overflow-x-auto lg:hidden">{filters.map(filter => <button key={filter.id} type="button" onClick={() => onChange(filter.id)} className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${value === filter.id ? 'bg-brand-600 text-white' : 'bg-surface text-muted'}`}>{filter.label}</button>)}</div>
}

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
      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface text-brand-600">{room.icon_file_id ? <img src={`/api/v1/files/${room.icon_file_id}/thumbnail`} alt="" className="h-full w-full object-cover" /> : <DoorOpen size={18} />}</span>
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

function DirectConversationRow({ conversation, activeRoomID, locale }: Readonly<{ conversation: DirectConversation; activeRoomID?: string; locale: string }>) {
  const navigate = useNavigate()
  const active = conversation.id === activeRoomID
  return <button type="button" onClick={() => navigate({ to: '/rooms/direct/$conversationID', params: { conversationID: conversation.id } }).catch(() => undefined)} className={`w-full rounded-lg p-3 text-left transition-colors ${active ? 'bg-brand-50 dark:bg-brand-900/30' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}><span className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"><MessageCircle size={17} /></span><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{conversation.other_display_name || conversation.other_email}</span><time className="text-xs text-muted">{roomTimestamp(conversation.updated_at, locale)}</time></span><span className="flex items-center justify-between gap-2 pt-1 text-xs text-muted"><span className="truncate">{conversation.source_room_name}</span>{conversation.unread_count > 0 && <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">{conversation.unread_count > 99 ? '99+' : conversation.unread_count}</span>}</span></span></span></button>
}

function StartPrivateChatDialog({ open, onOpenChange, email, onEmailChange, pending, onSubmit }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; email: string; onEmailChange: (email: string) => void; pending: boolean; onSubmit: () => void }>) {
  const { t } = useI18n()
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Trigger asChild><button type="button" className="notes-secondary-button w-full"><MailPlus size={17} /> {t('rooms.startPrivateChat' as never)}</button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-subtle bg-surface p-5 shadow-xl"><div className="flex items-start justify-between gap-4"><div><Dialog.Title className="text-lg font-semibold">{t('rooms.startPrivateChat' as never)}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted">{t('rooms.startPrivateChatDescription' as never)}</Dialog.Description></div><Dialog.Close asChild><button type="button" className="notes-icon-button" aria-label={t('action.close')}><X size={17} /></button></Dialog.Close></div><form className="mt-5" onSubmit={event => { event.preventDefault(); onSubmit() }}><label className="block text-sm font-medium" htmlFor="private-chat-email">{t('rooms.contactEmail' as never)}<input id="private-chat-email" type="email" autoFocus required value={email} onChange={event => onEmailChange(event.target.value)} className="notes-input mt-2 w-full" /></label><div className="mt-5 flex justify-end gap-2"><Dialog.Close asChild><button type="button" className="notes-secondary-button">{t('action.cancel')}</button></Dialog.Close><button type="submit" className="notes-primary-button" disabled={pending || !email.trim()}>{t('rooms.startPrivateChat' as never)}</button></div></form></Dialog.Content></Dialog.Portal></Dialog.Root>
}

export function RoomConversationSidebar({ activeRoomID, mobile = false }: Readonly<{ activeRoomID?: string; mobile?: boolean }>) {
  const { t, locale } = useI18n()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ConversationFilter>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(() => !activeRoomID)
  const [roomName, setRoomName] = useState('')
  const [privateChatOpen, setPrivateChatOpen] = useState(false)
  const [contactEmail, setContactEmail] = useState('')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const roomsQuery = useQuery({ queryKey: ['rooms'], queryFn: ({ signal }) => listRooms(signal), refetchInterval: 5_000, refetchIntervalInBackground: true })
  const directQuery = useQuery({ queryKey: ['rooms', 'direct-conversations'], queryFn: ({ signal }) => listDirectConversations(signal), refetchInterval: 5_000, refetchIntervalInBackground: true })
  const normalizedQuery = query.trim().toLocaleLowerCase(locale === 'da' ? 'da-DK' : 'en-US')
  const rooms = useMemo(() => (roomsQuery.data ?? []).filter(room => room.name.toLocaleLowerCase(locale === 'da' ? 'da-DK' : 'en-US').includes(normalizedQuery)).filter(room => filter !== 'direct' && (filter !== 'unread' || room.unread_count > 0)), [filter, locale, normalizedQuery, roomsQuery.data])
  const directConversations = useMemo(() => (directQuery.data ?? []).filter(conversation => `${conversation.other_display_name} ${conversation.other_email}`.toLocaleLowerCase(locale === 'da' ? 'da-DK' : 'en-US').includes(normalizedQuery)).filter(conversation => filter !== 'rooms' && (filter !== 'unread' || conversation.unread_count > 0)), [directQuery.data, filter, locale, normalizedQuery])
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
  const privateChatMutation = useMutation({
    mutationFn: () => startPrivateChatByEmail(contactEmail.trim()),
    onSuccess: result => {
      setPrivateChatOpen(false)
      setContactEmail('')
      if (result.conversation) {
        queryClient.invalidateQueries({ queryKey: ['rooms', 'direct-conversations'] }).catch(() => undefined)
        toast.success(t('rooms.privateChatCreated' as never))
        navigate({ to: '/rooms/direct/$conversationID', params: { conversationID: result.conversation.id } }).catch(() => undefined)
        return
      }
      toast[result.mail_sent ? 'success' : 'error'](t(result.mail_sent ? 'rooms.privateChatInvitationSent' : 'rooms.privateChatInvitationFailed' as never))
    },
    onError: () => toast.error(t('rooms.startDirectFailed')),
  })

  const sidebarClass = mobile
    ? 'mb-4 lg:hidden'
    : 'hidden min-h-0 border-r border-subtle pr-4 lg:flex lg:w-full lg:shrink-0 lg:flex-col'
  const privateChatDialog = <StartPrivateChatDialog open={privateChatOpen} onOpenChange={setPrivateChatOpen} email={contactEmail} onEmailChange={setContactEmail} pending={privateChatMutation.isPending} onSubmit={() => privateChatMutation.mutate()} />
  const content = <><div className="sticky top-0 z-10 bg-surface pb-3"><label className="relative mb-3 block"><span className="sr-only">{t('rooms.searchConversations' as never)}</span><Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('rooms.searchConversations' as never)} className="notes-input w-full pl-9" /></label>
      <ConversationFilters value={filter} onChange={setFilter} /></div>
    <div className="min-h-0 space-y-1 overflow-y-auto pb-3">
      {rooms.length > 0 && <><h2 className="mb-2 px-2 pt-1 text-sm font-semibold">{t('rooms.filterRooms')}</h2>{rooms.map(room => <RoomConversationRow key={room.id} room={room} activeRoomID={activeRoomID} locale={locale} />)}</>}
      {directConversations.length > 0 && <><h2 className="mb-2 mt-4 px-2 pt-1 text-sm font-semibold">{t('rooms.direct')}</h2>{directConversations.map(conversation => <DirectConversationRow key={conversation.id} conversation={conversation} activeRoomID={activeRoomID} locale={locale} />)}</>}
      {!roomsQuery.isLoading && rooms.length === 0 && directConversations.length === 0 && <p className="px-2 py-4 text-sm text-muted">{t('rooms.noMatchingRooms' as never)}</p>}
    </div>
    {privateChatDialog}
    {!activeRoomID && <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
      <Dialog.Trigger asChild><button type="button" className="notes-secondary-button mt-auto w-full"><Plus size={17} /> {t('rooms.create' as never)}</button></Dialog.Trigger>
      <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-subtle bg-surface p-5 shadow-xl"><div className="flex items-start justify-between gap-4"><div><Dialog.Title className="text-lg font-semibold">{t('rooms.create' as never)}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted">{t('rooms.createDescription' as never)}</Dialog.Description></div><Dialog.Close asChild><button type="button" className="notes-icon-button" aria-label={t('action.close')}><X size={17} /></button></Dialog.Close></div><form className="mt-5" onSubmit={event => { event.preventDefault(); createMutation.mutate() }}><label className="block text-sm font-medium" htmlFor="sidebar-room-name">{t('rooms.name' as never)}<input id="sidebar-room-name" autoFocus required maxLength={120} value={roomName} onChange={event => setRoomName(event.target.value)} placeholder={t('rooms.namePlaceholder' as never)} className="notes-input mt-2 w-full" /></label><div className="mt-5 flex justify-end gap-2"><Dialog.Close asChild><button type="button" className="notes-secondary-button">{t('action.cancel')}</button></Dialog.Close><button type="submit" className="notes-primary-button" disabled={createMutation.isPending || !roomName.trim()}>{t('rooms.create' as never)}</button></div></form></Dialog.Content></Dialog.Portal>
    </Dialog.Root>}</>
  if (mobile) {
    const unreadCount = (roomsQuery.data ?? []).reduce((total, room) => total + room.unread_count, 0) + (directQuery.data ?? []).reduce((total, conversation) => total + conversation.unread_count, 0)
    const list = <div className="space-y-1">{rooms.map(room => <RoomConversationRow key={room.id} room={room} activeRoomID={activeRoomID} locale={locale} />)}{directConversations.map(conversation => <DirectConversationRow key={conversation.id} conversation={conversation} activeRoomID={activeRoomID} locale={locale} />)}{!roomsQuery.isLoading && rooms.length === 0 && directConversations.length === 0 && <p className="px-2 py-4 text-sm text-muted">{t('rooms.noMatchingRooms' as never)}</p>}</div>
    return <aside className={sidebarClass} aria-label={t('rooms.conversations' as never)}><Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}><Dialog.Trigger asChild><button type="button" className="flex w-full items-center justify-between rounded-lg border border-subtle bg-surface px-3 py-2 text-sm font-medium">{t('rooms.conversations' as never)}{unreadCount > 0 && <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-xs text-white">{unreadCount}</span>}<ChevronDown size={17} /></button></Dialog.Trigger><label className="relative my-3 block"><span className="sr-only">{t('rooms.searchConversations' as never)}</span><Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('rooms.searchConversations' as never)} className="notes-input w-full pl-9" /></label><ConversationFilters value={filter} onChange={setFilter} /><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" /><Dialog.Content className="fixed inset-x-0 bottom-0 top-0 z-50 flex flex-col bg-surface p-4 pt-[max(1rem,env(safe-area-inset-top))] shadow-xl"><div className="mb-4 flex items-center justify-between"><Dialog.Title className="text-lg font-semibold">{t('rooms.conversations' as never)}</Dialog.Title><Dialog.Close asChild><button type="button" className="notes-icon-button" aria-label={t('action.close')}><X size={18} /></button></Dialog.Close></div><label className="relative mb-3 block"><span className="sr-only">{t('rooms.searchConversations' as never)}</span><Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('rooms.searchConversations' as never)} className="notes-input w-full pl-9" /></label><ConversationFilters value={filter} onChange={setFilter} /><div className="min-h-0 flex-1 overflow-y-auto">{list}</div></Dialog.Content></Dialog.Portal></Dialog.Root><div className="mt-3">{privateChatDialog}</div></aside>
  }
  return <aside className={sidebarClass} aria-label={t('rooms.conversations' as never)}>{content}</aside>
}
