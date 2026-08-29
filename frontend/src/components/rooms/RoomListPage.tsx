import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Archive, DoorOpen } from 'lucide-react'
import { toast } from 'sonner'
import { RoomConversationSidebar } from '@/components/rooms/RoomConversationSidebar'
import { MobileRoomsInstallBanner } from '@/components/rooms/MobileRoomsInstallBanner'
import { useI18n } from '@/lib/i18n'
import { archiveRoom, listRooms, type Room } from '@/lib/rooms'

function RoomOverviewCard({ room }: Readonly<{ room: Room }>) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const archive = useMutation({ mutationFn: () => archiveRoom(room.id), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['rooms'] }).catch(() => undefined); toast.success(t('rooms.archived' as never)) }, onError: () => toast.error(t('rooms.archiveFailed' as never)) })
  const confirmArchive = () => {
    if (window.confirm(t('rooms.archiveConfirm' as never, { name: room.name }))) archive.mutate()
  }
  return <article className="flex items-center gap-3 rounded-xl border border-subtle bg-surface p-4"><button type="button" onClick={() => navigate({ to: '/rooms/$roomID', params: { roomID: room.slug } }).catch(() => undefined)} className="flex min-w-0 flex-1 items-center gap-3 text-left"><span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-900/30">{room.icon_file_id ? <img src={`/api/v1/files/${room.icon_file_id}/thumbnail`} alt="" className="h-full w-full object-cover" /> : <DoorOpen size={21} />}</span><span className="min-w-0"><span className="block truncate font-semibold">{room.name}</span><span className="mt-1 block text-sm text-muted">{t(`rooms.role.${room.current_role}` as never)}</span></span></button>{room.current_role === 'owner' && <button type="button" className="notes-icon-button text-red-500" title={t('rooms.archive' as never)} aria-label={t('rooms.archive' as never)} onClick={confirmArchive} disabled={archive.isPending}><Archive size={17} /></button>}</article>
}

export function RoomListPage() {
  const { t } = useI18n()
  const rooms = useQuery({ queryKey: ['rooms'], queryFn: ({ signal }) => listRooms(signal) })
  return <section className="mx-auto w-full max-w-[112rem] animate-fade-in lg:h-full" aria-labelledby="rooms-heading"><div className="lg:hidden"><MobileRoomsInstallBanner /></div><div className="grid lg:h-full lg:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)] lg:gap-4 lg:overflow-hidden"><RoomConversationSidebar mobile /><RoomConversationSidebar /><main className="min-h-[20rem] lg:min-h-0 lg:overflow-y-auto"><h1 id="rooms-heading" className="text-xl font-semibold">{t('rooms.title' as never)}</h1><p className="mt-2 text-sm text-muted">{t('rooms.selectConversation' as never)}</p><div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{(rooms.data ?? []).map(room => <RoomOverviewCard key={room.id} room={room} />)}</div></main></div></section>
}
