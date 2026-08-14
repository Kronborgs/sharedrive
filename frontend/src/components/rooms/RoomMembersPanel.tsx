import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, UserRound, X } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'
import { addRoomMember, listRoomMembers, removeRoomMember, type Room, type RoomRole } from '@/lib/rooms'

export function RoomMembersPanel({ room }: Readonly<{ room: Room }>) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Exclude<RoomRole, 'owner'>>('member')
  const membersQuery = useQuery({
    queryKey: ['rooms', room.id, 'members'],
    queryFn: ({ signal }) => listRoomMembers(room.id, signal),
  })
  const addMutation = useMutation({
    mutationFn: () => addRoomMember(room.id, email, role),
    onSuccess: () => {
      setEmail('')
      setRole('member')
      setDialogOpen(false)
      queryClient.invalidateQueries({ queryKey: ['rooms', room.id, 'members'] }).catch(() => undefined)
      toast.success(t('rooms.memberAdded' as never))
    },
    onError: () => toast.error(t('rooms.memberAddFailed' as never)),
  })
  const removeMutation = useMutation({
    mutationFn: (userID: string) => removeRoomMember(room.id, userID),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rooms', room.id, 'members'] }).catch(() => undefined)
      toast.success(t('rooms.memberRemoved' as never))
    },
    onError: () => toast.error(t('rooms.memberRemoveFailed' as never)),
  })
  const canManage = room.current_role === 'owner' || room.current_role === 'moderator'
  const members = membersQuery.data ?? []

  return (
    <section className="border-t border-zinc-200 pt-6 dark:border-[#2d3148]" aria-labelledby="room-members-heading">
      <div className="flex items-center justify-between gap-3">
        <h2 id="room-members-heading" className="text-base font-semibold text-zinc-950 dark:text-white">{t('rooms.members' as never)}</h2>
        {canManage && (
          <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
            <Dialog.Trigger asChild>
              <button type="button" className="flex items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm hover:bg-zinc-100 dark:border-[#3a3f58] dark:hover:bg-[#2d3148]">
                <Plus size={15} /> {t('rooms.addMember' as never)}
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
              <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-[#2d3148] dark:bg-[#1a1d27]">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <Dialog.Title className="text-lg font-semibold text-zinc-950 dark:text-white">{t('rooms.addMember' as never)}</Dialog.Title>
                    <Dialog.Description className="mt-1 text-sm text-muted">{t('rooms.addMemberDescription' as never)}</Dialog.Description>
                  </div>
                  <Dialog.Close asChild><button type="button" className="notes-icon-button" aria-label={t('action.close')}><X size={17} /></button></Dialog.Close>
                </div>
                <form className="mt-5 space-y-4" onSubmit={event => { event.preventDefault(); addMutation.mutate() }}>
                  <label className="block text-sm font-medium text-zinc-800 dark:text-slate-200" htmlFor="room-member-email">
                    {t('rooms.memberEmail' as never)}
                    <input id="room-member-email" type="email" autoFocus required value={email} onChange={event => setEmail(event.target.value)} className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-[#3a3f58] dark:bg-[#11141e]" />
                  </label>
                  <label className="block text-sm font-medium text-zinc-800 dark:text-slate-200" htmlFor="room-member-role">
                    {t('rooms.memberRole' as never)}
                    <select id="room-member-role" value={role} onChange={event => setRole(event.target.value as Exclude<RoomRole, 'owner'>)} className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-[#3a3f58] dark:bg-[#11141e]">
                      <option value="member">{t('rooms.role.member' as never)}</option>
                      {room.current_role === 'owner' && <option value="moderator">{t('rooms.role.moderator' as never)}</option>}
                    </select>
                  </label>
                  <div className="flex justify-end gap-2 pt-1">
                    <Dialog.Close asChild><button type="button" className="rounded-md px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-[#2d3148]">{t('action.cancel')}</button></Dialog.Close>
                    <button type="submit" className="notes-primary-button" disabled={addMutation.isPending || !email.trim()}>{t('rooms.addMember' as never)}</button>
                  </div>
                </form>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        )}
      </div>

      {membersQuery.isLoading && <p className="mt-4 text-sm text-muted">{t('rooms.loadingMembers' as never)}</p>}
      {membersQuery.isError && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{t('rooms.membersLoadFailed' as never)}</p>}
      <ul className="mt-4 divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-[#2d3148] dark:border-[#2d3148]">
        {members.map(member => {
          const canRemove = member.role !== 'owner' && (room.current_role === 'owner' || member.role === 'member')
          return (
            <li key={member.user_id} className="flex min-h-16 items-center gap-3 py-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-400"><UserRound size={17} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-zinc-950 dark:text-white">{member.display_name || member.email}</span>
                <span className="block truncate text-xs text-muted">{member.email}</span>
              </span>
              <span className="text-xs text-muted">{t(`rooms.role.${member.role}` as never)}</span>
              {canManage && canRemove && (
                <button type="button" className="notes-icon-button text-red-600" aria-label={t('rooms.removeMember' as never)} onClick={() => removeMutation.mutate(member.user_id)} disabled={removeMutation.isPending}>
                  <Trash2 size={15} />
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
