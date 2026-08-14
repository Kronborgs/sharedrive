import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Archive, ArrowLeft, Copy, DoorOpen, Users } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'
import { archiveRoom, getRoom } from '@/lib/rooms'
import { RoomMembersPanel } from '@/components/rooms/RoomMembersPanel'
import { updateRoom } from '@/lib/rooms'

export function RoomDetailPage({ roomID }: Readonly<{ roomID: string }>) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const roomQuery = useQuery({
    queryKey: ['rooms', roomID],
    queryFn: ({ signal }) => getRoom(roomID, signal),
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

  return (
    <section className="mx-auto max-w-5xl animate-fade-in" aria-labelledby="room-heading">
      <button type="button" className="mb-5 flex items-center gap-1.5 text-sm text-muted hover:text-zinc-950 dark:hover:text-white" onClick={() => navigate({ to: '/rooms' }).catch(() => undefined)}>
        <ArrowLeft size={16} /> {t('rooms.back' as never)}
      </button>

      <header className="border-b border-zinc-200 pb-6 dark:border-[#2d3148]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400"><DoorOpen size={21} /></span>
            <div className="min-w-0">
              <h1 id="room-heading" className="truncate text-2xl font-semibold text-zinc-950 dark:text-white">{room.name}</h1>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-muted"><Users size={15} /> {t(`rooms.role.${room.current_role}` as never)}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-[#3a3f58] dark:hover:bg-[#2d3148]" onClick={() => { copyLink().catch(() => toast.error(t('rooms.copyFailed' as never))) }}>
              <Copy size={16} /> {t('rooms.copyLink' as never)}
            </button>
            {(room.current_role === 'owner' || room.current_role === 'moderator') && (
              <button type="button" className="flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100 dark:border-[#3a3f58] dark:hover:bg-[#2d3148]" onClick={() => {
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
                {t('action.rename')}
              </button>
            )}
            {room.current_role === 'owner' && (
              <button type="button" className="flex items-center gap-1.5 rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30" onClick={() => archiveMutation.mutate()} disabled={archiveMutation.isPending}>
                <Archive size={16} /> {t('rooms.archive' as never)}
              </button>
            )}
          </div>
        </div>
      </header>

      <RoomMembersPanel room={room} />
    </section>
  )
}
