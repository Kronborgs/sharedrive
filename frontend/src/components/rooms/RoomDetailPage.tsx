import * as Dialog from '@radix-ui/react-dialog'
import { useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Copy, DoorOpen, ImagePlus, Info, Pencil, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'
import { getPublicRoomSettings, getRoom, listRoomMembers, updateRoom, updateRoomIcon } from '@/lib/rooms'
import { api } from '@/lib/api'
import type { FileItem } from '@/types/api'
import { AddPersonDialog, RoomMembersPanel } from '@/components/rooms/RoomMembersPanel'
import { RoomChatPanel } from '@/components/rooms/RoomChatPanel'
import { RoomInvitesPanel } from '@/components/rooms/RoomInvitesPanel'
import { RoomVoicePanel } from '@/components/rooms/RoomVoicePanel'
import { RoomsInstallButton } from '@/components/rooms/RoomsInstallButton'
import { MobileRoomsInstallBanner } from '@/components/rooms/MobileRoomsInstallBanner'
import { RoomConversationSidebar } from '@/components/rooms/RoomConversationSidebar'

export function RoomDetailPage({ roomID }: Readonly<{ roomID: string }>) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const iconInputRef = useRef<HTMLInputElement>(null)
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

  if (roomQuery.isLoading) return <p className="text-sm text-muted">{t('rooms.loading' as never)}</p>
  if (roomQuery.isError || !roomQuery.data) return <p className="text-sm text-red-600 dark:text-red-400">{t('rooms.loadFailed' as never)}</p>

  const room = roomQuery.data
  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.href)
    toast.success(t('rooms.linkCopied' as never))
  }
  const uploadIcon = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.error(t('rooms.fileUploadFailed' as never))
      return
    }
    const formData = new FormData()
    formData.append('file', file)
    const uploaded = await api.post<FileItem>('/api/v1/files/upload', formData)
    const updated = await updateRoomIcon(room.id, uploaded.id)
    queryClient.setQueryData(['rooms', roomID], updated)
    queryClient.invalidateQueries({ queryKey: ['rooms'] }).catch(() => undefined)
  }
  const handleIconChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      uploadIcon(file).catch(() => toast.error(t('rooms.fileUploadFailed' as never)))
    }
    event.currentTarget.value = ''
  }

  const memberCount = membersQuery.data?.length
  const detailGridClass = 'lg:grid-cols-[minmax(0,1fr)_minmax(17rem,21rem)]'

  return (
    <section className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-[112rem] flex-col overflow-hidden animate-fade-in lg:h-full" aria-labelledby="room-heading">
      <button type="button" className="mb-3 hidden items-center gap-1.5 text-sm text-muted hover:text-zinc-950 dark:hover:text-white lg:flex" onClick={() => navigate({ to: '/rooms' }).catch(() => undefined)}>
        <ArrowLeft size={16} /> {t('rooms.back' as never)}
      </button>

      <div className="lg:hidden"><MobileRoomsInstallBanner /></div>
      <div className={`flex min-h-0 flex-1 flex-col gap-2 lg:grid lg:gap-4 lg:overflow-hidden ${detailGridClass}`}>
        <RoomConversationSidebar activeRoomID={room.id} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col lg:order-1 lg:pr-4">
          <header className="sticky top-0 z-10 shrink-0 border-b border-subtle bg-surface py-2 lg:py-3">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <button type="button" className="notes-icon-button shrink-0 lg:hidden" aria-label={t('rooms.back' as never)} onClick={() => navigate({ to: '/rooms' }).catch(() => undefined)}><ArrowLeft size={18} /></button><span className="relative flex h-9 w-9 lg:mt-0.5 lg:h-10 lg:w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400">{room.icon_file_id ? <img src={`/api/v1/files/${room.icon_file_id}/thumbnail`} alt="" className="h-full w-full object-cover" /> : <DoorOpen size={21} />}{(room.current_role === 'owner' || room.current_role === 'moderator') && <label className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/55 text-white opacity-0 transition-opacity hover:opacity-100" title={t('rooms.changeIcon' as never)}><ImagePlus size={17} /><input ref={iconInputRef} type="file" accept="image/*" className="sr-only" onChange={handleIconChange} /></label>}</span>
              <div className="min-w-0">
                <h1 id="room-heading" className="truncate text-xl font-semibold text-zinc-950 dark:text-white lg:text-2xl">{room.name}</h1>
                <p className="flex items-center gap-1.5 text-xs text-muted lg:mt-1 lg:text-sm"><Users size={15} /> {memberCount === undefined ? t(`rooms.role.${room.current_role}` as never) : `${t('rooms.permanentWorkspace' as never)} · ${t('rooms.roomMembers' as never, { count: memberCount })}`}</p>
              </div>
            </div>
          <div className="rooms-toolbar-panel flex shrink-0 items-center gap-1">
            {settingsQuery.data?.rooms_voice_enabled && <RoomVoicePanel roomID={room.id} meetingActive={room.voice_active} compact />}<Dialog.Root><Dialog.Trigger asChild><button type="button" className="notes-icon-button" title={t('rooms.showContext' as never)} aria-label={t('rooms.showContext' as never)}><Info size={18} /></button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" /><Dialog.Content className="fixed inset-x-4 top-1/2 z-50 max-h-[80dvh] -translate-y-1/2 overflow-y-auto rounded-lg border border-subtle bg-surface p-5 shadow-xl sm:left-1/2 sm:w-full sm:max-w-md sm:-translate-x-1/2"><div className="flex items-start justify-between gap-3"><Dialog.Title className="text-lg font-semibold">{room.name}</Dialog.Title><Dialog.Close asChild><button type="button" className="notes-icon-button" aria-label={t('action.close')}><X size={17} /></button></Dialog.Close></div><div className="mt-5 space-y-6"><RoomMembersPanel room={room} /><RoomInvitesPanel room={room} /></div></Dialog.Content></Dialog.Portal></Dialog.Root>
            {(room.current_role === 'owner' || room.current_role === 'moderator') && <span className="hidden lg:block"><AddPersonDialog room={room} compact /></span>}
            <span className="hidden lg:block"><RoomsInstallButton compact /></span>
            <button type="button" className="hidden rooms-toolbar-button lg:flex" title={t('rooms.copyLink' as never)} onClick={() => { copyLink().catch(() => toast.error(t('rooms.copyFailed' as never))) }}>
              <Copy size={16} /> <span className="hidden min-[1360px]:inline">{t('rooms.copyLink' as never)}</span>
            </button>
            {(room.current_role === 'owner' || room.current_role === 'moderator') && (
              <button type="button" className="hidden rooms-toolbar-button lg:flex" title={t('action.rename')} onClick={() => {
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
                <Pencil size={16} /> <span className="hidden min-[1200px]:inline">{t('action.rename')}</span>
              </button>
            )}
          </div>
          </div>
          </header>
          <RoomChatPanel room={room} fillAvailableHeight />
        </main>
        <aside className="hidden space-y-6 border-t border-subtle pt-4" aria-label={t('rooms.members' as never)}>
          <RoomMembersPanel room={room} />
          <RoomInvitesPanel room={room} />
        </aside>
      </div>
    </section>
  )
}
