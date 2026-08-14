import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { DoorOpen, Plus, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'
import { createRoom, listRooms } from '@/lib/rooms'

export function RoomListPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [name, setName] = useState('')
  const roomsQuery = useQuery({
    queryKey: ['rooms'],
    queryFn: ({ signal }) => listRooms(signal),
  })
  const createMutation = useMutation({
    mutationFn: () => createRoom(name),
    onSuccess: room => {
      setDialogOpen(false)
      setName('')
      queryClient.invalidateQueries({ queryKey: ['rooms'] }).catch(() => undefined)
      navigate({ to: '/rooms/$roomID', params: { roomID: room.slug } }).catch(() => undefined)
    },
    onError: () => toast.error(t('rooms.createFailed' as never)),
  })

  const rooms = roomsQuery.data ?? []

  return (
    <section className="mx-auto max-w-6xl animate-fade-in" aria-labelledby="rooms-heading">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 id="rooms-heading" className="text-2xl font-semibold text-zinc-950 dark:text-white">{t('rooms.title' as never)}</h1>
          <p className="mt-1 text-sm text-muted">{t('rooms.subtitle' as never)}</p>
        </div>
        <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
          <Dialog.Trigger asChild>
            <button type="button" className="notes-primary-button shrink-0">
              <Plus size={17} /> {t('rooms.create' as never)}
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-[#2d3148] dark:bg-[#1a1d27]">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Dialog.Title className="text-lg font-semibold text-zinc-950 dark:text-white">{t('rooms.create' as never)}</Dialog.Title>
                  <Dialog.Description className="mt-1 text-sm text-muted">{t('rooms.createDescription' as never)}</Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button type="button" className="notes-icon-button" aria-label={t('action.close')}><X size={17} /></button>
                </Dialog.Close>
              </div>
              <form className="mt-5" onSubmit={event => { event.preventDefault(); createMutation.mutate() }}>
                <label className="block text-sm font-medium text-zinc-800 dark:text-slate-200" htmlFor="room-name">{t('rooms.name' as never)}</label>
                <input
                  id="room-name"
                  autoFocus
                  required
                  maxLength={120}
                  value={name}
                  onChange={event => setName(event.target.value)}
                  placeholder={t('rooms.namePlaceholder' as never)}
                  className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-[#3a3f58] dark:bg-[#11141e]"
                />
                <div className="mt-5 flex justify-end gap-2">
                  <Dialog.Close asChild><button type="button" className="rounded-md px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-[#2d3148]">{t('action.cancel')}</button></Dialog.Close>
                  <button type="submit" className="notes-primary-button" disabled={createMutation.isPending || !name.trim()}>{t('rooms.create' as never)}</button>
                </div>
              </form>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </header>

      {roomsQuery.isLoading && <p className="text-sm text-muted">{t('rooms.loading' as never)}</p>}
      {roomsQuery.isError && <p className="text-sm text-red-600 dark:text-red-400">{t('rooms.loadFailed' as never)}</p>}
      {!roomsQuery.isLoading && !roomsQuery.isError && rooms.length === 0 && (
        <div className="border-y border-dashed border-zinc-300 py-16 text-center dark:border-zinc-700">
          <DoorOpen className="mx-auto mb-3 text-brand-500" size={30} />
          <p className="text-sm text-muted">{t('rooms.empty' as never)}</p>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rooms.map(room => (
          <button
            key={room.id}
            type="button"
            onClick={() => navigate({ to: '/rooms/$roomID', params: { roomID: room.slug } }).catch(() => undefined)}
            className="min-h-32 rounded-lg border border-zinc-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-brand-400 dark:border-[#2d3148] dark:bg-[#1a1d27] dark:hover:border-brand-600"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-semibold text-zinc-950 dark:text-white">{room.name}</h2>
              <DoorOpen size={18} className="shrink-0 text-brand-500" />
            </div>
            <div className="mt-8 flex items-center justify-between text-xs text-muted">
              <span className="flex items-center gap-1.5"><Users size={14} /> {t(`rooms.role.${room.current_role}` as never)}</span>
              <time dateTime={room.updated_at}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(room.updated_at))}</time>
            </div>
          </button>
        ))}
      </div>
    </section>
  )
}
