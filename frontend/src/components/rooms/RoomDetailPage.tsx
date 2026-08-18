import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Archive, ArrowLeft, Copy, DoorOpen, PanelRightClose, PanelRightOpen, Pencil, Users } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'
import { archiveRoom, getPublicRoomSettings, getRoom, listRoomMembers, updateRoom } from '@/lib/rooms'
import { RoomMembersPanel } from '@/components/rooms/RoomMembersPanel'
import { RoomChatPanel } from '@/components/rooms/RoomChatPanel'
import { RoomInvitesPanel } from '@/components/rooms/RoomInvitesPanel'
import { RoomVoicePanel } from '@/components/rooms/RoomVoicePanel'
import { RoomsInstallButton } from '@/components/rooms/RoomsInstallButton'
import { RoomConversationSidebar } from '@/components/rooms/RoomConversationSidebar'

export function RoomDetailPage({ roomID }: Readonly<{ roomID: string }>) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [contextVisible, setContextVisible] = useState(true)
  const roomQuery = useQuery({
    queryKey: ['rooms', roomID],
    queryFn: ({ signal }) => getRoom(roomID, signal),
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
  })
  const settingsQuery = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: ({ signal }) => getPublicRoomSettings(signal),
    staleTime: 60_000,
  })
  const membersQuery = useQuery({
    queryKey: ['rooms', roomID, 'members'],
    queryFn: ({ signal }) => listRoomMembers(roomID, signal),
  })
  const archiveMutation = useMutation({
    mutationFn: () => {
      if (!roomQuery.data) throw new Error('Room is not loaded')
      return archiveRoom(roomQuery.data.id)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rooms'] }).catch(() => undefined)
      toast.success(t('rooms.archived' as never))
      navigate({ to: '/rooms' }).catch(() => undefined)
    },
    onError: () => toast.error(t('rooms.archiveFailed' as never)),
  })

  if (roomQuery.isLoading) return <p className="text-sm text-muted">{t('rooms.loading' as never)}</p>
  if (roomQuery.isError || !roomQuery.data) return <p className="text-sm text-red-600 dark:text-red-400">{t('rooms.loadFailed' as never)}</p>

  const room = roomQuery.data
  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.href)
    toast.success(t('rooms.linkCopied' as never))
  }

  const memberCount = membersQuery.data?.length
  const detailGridClass = contextVisible
    ? 'lg:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[17rem_minmax(0,1fr)_19rem]'
    : 'lg:grid-cols-[minmax(0,1fr)] xl:grid-cols-[17rem_minmax(0,1fr)]'

  return (
    <section className="mx-auto flex w-full max-w-[112rem] flex-col animate-fade-in lg:h-full lg:overflow-hidden" aria-labelledby="room-heading">
      <button type="button" className="mb-3 flex items-center gap-1.5 text-sm text-muted hover:text-zinc-950 dark:hover:text-white" onClick={() => navigate({ to: '/rooms' }).catch(() => undefined)}>
        <ArrowLeft size={16} /> {t('rooms.back' as never)}
      </button>

      <div className={`grid min-h-0 gap-4 lg:flex-1 lg:overflow-hidden ${detailGridClass}`}>
        <RoomConversationSidebar activeRoomID={room.id} mobile />
        <RoomConversationSidebar activeRoomID={room.id} />
        <main className="flex min-w-0 flex-col lg:min-h-0">
          <header className="shrink-0 border-b border-subtle pb-4">
          <div className="flex flex-col gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400"><DoorOpen size={21} /></span>
            <div className="min-w-0">
              <h1 id="room-heading" className="truncate text-2xl font-semibold text-zinc-950 dark:text-white">{room.name}</h1>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-muted"><Users size={15} /> {memberCount === undefined ? t(`rooms.role.${room.current_role}` as never) : `${t('rooms.permanentWorkspace' as never)} · ${t('rooms.roomMembers' as never, { count: memberCount })}`}</p>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 pb-1">
            {settingsQuery.data?.rooms_voice_enabled && <RoomVoicePanel roomID={room.id} meetingActive={room.voice_active} compact />}
            <button type="button" className="notes-icon-button" onClick={() => setContextVisible(value => !value)} aria-label={contextVisible ? t('rooms.hideContext' as never) : t('rooms.showContext' as never)} title={contextVisible ? t('rooms.hideContext' as never) : t('rooms.showContext' as never)}>{contextVisible ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
            <RoomsInstallButton compact />
            <button type="button" className="notes-secondary-button shrink-0" title={t('rooms.copyLink' as never)} onClick={() => { copyLink().catch(() => toast.error(t('rooms.copyFailed' as never))) }}>
              <Copy size={16} /> <span className="hidden sm:inline 2xl:inline">{t('rooms.copyLink' as never)}</span>
            </button>
            {(room.current_role === 'owner' || room.current_role === 'moderator') && (
              <button type="button" className="notes-secondary-button shrink-0" title={t('action.rename')} onClick={() => {
                const name = window.prompt(t('rooms.name' as never), room.name)
                if (!name?.trim() || name.trim() === room.name) return
                updateRoom(room.id, name.trim())
                  .then(updatedRoom => {
                    queryClient.setQueryData(['rooms', roomID], updatedRoom)
                    queryClient.invalidateQueries({ queryKey: ['rooms'] }).catch(() => undefined)
                    toast.success(t('action.save'))
                  })
                  .catch(() => toast.error(t('rooms.createFailed' as never)))
              }}>
                <Pencil size={16} /> <span className="hidden sm:inline 2xl:inline">{t('action.rename')}</span>
              </button>
            )}
            {room.current_role === 'owner' && (
              <button type="button" className="flex shrink-0 items-center gap-1.5 rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30" title={t('rooms.archive' as never)} onClick={() => archiveMutation.mutate()} disabled={archiveMutation.isPending}>
                <Archive size={16} /> <span className="hidden sm:inline 2xl:inline">{t('rooms.archive' as never)}</span>
              </button>
            )}
          </div>
          </div>
          </header>
          <RoomChatPanel room={room} fillAvailableHeight />
        </main>
        {contextVisible && <aside className="space-y-6 border-t border-subtle pt-4 lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:pl-4 lg:pt-0" aria-label={t('rooms.members' as never)}>
          <RoomMembersPanel room={room} />
          <RoomInvitesPanel room={room} />
        </aside>}
      </div>
    </section>
  )
}
