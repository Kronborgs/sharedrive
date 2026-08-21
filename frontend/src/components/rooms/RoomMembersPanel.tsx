import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageCircle, Plus, Trash2, UserRound, X } from 'lucide-react'
import { toast } from 'sonner'
import { useNavigate } from '@tanstack/react-router'
import { ApiClientError } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { useI18n } from '@/lib/i18n'
import {
  addRoomMember,
  createDirectConversation,
  createRoomInvite,
  listRoomMembers,
  removeRoomMember,
  type Room,
  type RoomInvitationResult,
  type RoomMember,
  type RoomRole,
} from '@/lib/rooms'

type InviteRole = Exclude<RoomRole, 'owner'> | 'guest'
type Translator = ReturnType<typeof useI18n>['t']

interface GuestPermissionsProps {
  expiresHours: number
  setExpiresHours: (value: number) => void
  canChat: boolean
  setCanChat: (value: boolean) => void
  canUpload: boolean
  setCanUpload: (value: boolean) => void
  canVoice: boolean
  setCanVoice: (value: boolean) => void
  canShareScreen: boolean
  setCanShareScreen: (value: boolean) => void
}

function GuestPermissions(props: Readonly<GuestPermissionsProps>) {
  const { t } = useI18n()
  return <fieldset className="space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-[#2d3148]">
    <legend className="px-1 text-sm font-medium">{t('rooms.guestPermissions')}</legend>
    <label className="block text-sm">
      <span className="block">{t('rooms.validHours')}</span>
      <input type="number" min={1} max={720} value={props.expiresHours} onChange={event => props.setExpiresHours(Number(event.target.value))} className="mt-1 w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-[#3a3f58]" />
    </label>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={props.canChat} onChange={event => props.setCanChat(event.target.checked)} /> {t('rooms.canChat')}</label>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={props.canUpload} onChange={event => props.setCanUpload(event.target.checked)} /> {t('rooms.canUpload')}</label>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={props.canVoice} onChange={event => props.setCanVoice(event.target.checked)} /> {t('rooms.canVoice')}</label>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={props.canShareScreen} onChange={event => props.setCanShareScreen(event.target.checked)} /> {t('rooms.canShareScreen')}</label>
  </fieldset>
}

async function showInvitationResult(result: RoomInvitationResult, t: Translator) {
  if (result.mail_sent) {
    toast.success(t('rooms.invitationMailed'))
    return
  }
  if (!result.invite_url) {
    toast.warning(t('rooms.memberMailFailed'))
    return
  }
  try {
    await navigator.clipboard.writeText(result.invite_url)
    toast.warning(t('rooms.inviteCopied'))
  } catch {
    window.prompt(t('rooms.copyGuestLink'), result.invite_url)
  }
}

function showAddError(error: unknown, t: Translator) {
  if (error instanceof ApiClientError && error.status === 422) {
    toast.error(t('rooms.accountNotActive'))
    return
  }
  toast.error(t('rooms.personAddFailed'))
}

function AddPersonDialog({ room }: Readonly<{ room: Room }>) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<InviteRole>('member')
  const [expiresHours, setExpiresHours] = useState(24)
  const [canChat, setCanChat] = useState(true)
  const [canUpload, setCanUpload] = useState(false)
  const [canVoice, setCanVoice] = useState(false)
  const [canShareScreen, setCanShareScreen] = useState(false)

  const resetForm = () => {
    setEmail('')
    setRole('member')
    setExpiresHours(24)
    setCanChat(true)
    setCanUpload(false)
    setCanVoice(false)
    setCanShareScreen(false)
  }
  const mutation = useMutation({
    mutationFn: () => role === 'guest'
      ? createRoomInvite(room.id, { email: email.trim(), label: email.trim(), expires_hours: expiresHours, can_chat: canChat, can_upload: canUpload, can_voice: canVoice, can_share_screen: canShareScreen })
      : addRoomMember(room.id, email.trim(), role),
    onSuccess: async result => {
      setOpen(false)
      resetForm()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['rooms', room.id, 'members'] }),
        queryClient.invalidateQueries({ queryKey: ['rooms', room.id, 'invites'] }),
      ])
      await showInvitationResult(result, t)
    },
    onError: error => showAddError(error, t),
  })
  const guestPermissions = { expiresHours, setExpiresHours, canChat, setCanChat, canUpload, setCanUpload, canVoice, setCanVoice, canShareScreen, setCanShareScreen }
  const invalidExpiry = role === 'guest' && (expiresHours < 1 || expiresHours > 720)

  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild>
      <button type="button" className="flex items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm hover:bg-zinc-100 dark:border-[#3a3f58] dark:hover:bg-[#2d3148]"><Plus size={15} /> {t('rooms.addPerson')}</button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-[#2d3148] dark:bg-[#1a1d27]">
        <div className="flex items-start justify-between gap-4">
          <div><Dialog.Title className="text-lg font-semibold text-zinc-950 dark:text-white">{t('rooms.addPerson')}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted">{t('rooms.addPersonDescription')}</Dialog.Description></div>
          <Dialog.Close asChild><button type="button" className="notes-icon-button" aria-label={t('action.close')}><X size={17} /></button></Dialog.Close>
        </div>
        <form className="mt-5 space-y-4" onSubmit={event => { event.preventDefault(); mutation.mutate() }}>
          <label className="block text-sm font-medium" htmlFor="room-person-email"><span className="block">{t('rooms.email')}</span><input id="room-person-email" type="email" autoFocus required value={email} onChange={event => setEmail(event.target.value)} className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-[#3a3f58] dark:bg-[#11141e]" /></label>
          <label className="block text-sm font-medium" htmlFor="room-person-role"><span className="block">{t('rooms.role')}</span><select id="room-person-role" value={role} onChange={event => setRole(event.target.value as InviteRole)} className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-[#3a3f58] dark:bg-[#11141e]"><option value="member">{t('rooms.role.member')}</option>{room.current_role === 'owner' && <option value="moderator">{t('rooms.role.moderator')}</option>}<option value="guest">{t('rooms.role.guest')}</option></select></label>
          {role === 'guest' && <GuestPermissions {...guestPermissions} />}
          <div className="flex justify-end gap-2"><Dialog.Close asChild><button type="button" className="rounded-md px-3 py-2 text-sm">{t('action.cancel')}</button></Dialog.Close><button type="submit" className="notes-primary-button" disabled={mutation.isPending || !email.trim() || invalidExpiry}>{t('rooms.addAndSend')}</button></div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function MemberList({ members, room, currentUserID, onDirect, onRemove }: Readonly<{ members: RoomMember[]; room: Room; currentUserID?: string; onDirect: (userID: string) => void; onRemove: (userID: string) => void }>) {
  const { t } = useI18n()
  const canManage = room.current_role === 'owner' || room.current_role === 'moderator'

  return <ul className="mt-4 divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-[#2d3148] dark:border-[#2d3148]">
    {members.map(member => {
      const canRemove = member.role !== 'owner' && (room.current_role === 'owner' || member.role === 'member')
      const canStartDirect = member.user_id !== currentUserID
      return <li key={member.user_id} className="group flex min-h-16 items-center gap-3 py-3">
        <button type="button" disabled={!canStartDirect} onClick={() => onDirect(member.user_id)} className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default" aria-label={canStartDirect ? t('rooms.startDirect', { name: member.display_name || member.email }) : undefined}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700"><UserRound size={17} /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{member.display_name || member.email}</span><span className="block truncate text-xs text-muted">{member.email}</span></span>
          {canStartDirect && <MessageCircle size={16} className="shrink-0 text-muted opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100" />}
        </button>
        <span className="text-xs text-muted">{t(`rooms.role.${member.role}` as never)}</span>
        {canManage && canRemove && <button type="button" className="notes-icon-button text-red-600 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" aria-label={t('rooms.removeMember' as never)} onClick={() => onRemove(member.user_id)}><Trash2 size={15} /></button>}
      </li>
    })}
  </ul>
}

export function RoomMembersPanel({ room }: Readonly<{ room: Room }>) {
  const { t } = useI18n()
  const { user } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const membersQuery = useQuery({ queryKey: ['rooms', room.id, 'members'], queryFn: ({ signal }) => listRoomMembers(room.id, signal) })
  const removeMutation = useMutation({
    mutationFn: (userID: string) => removeRoomMember(room.id, userID),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rooms', room.id, 'members'] }).catch(() => undefined)
      toast.success(t('rooms.memberRemoved' as never))
    },
    onError: () => toast.error(t('rooms.memberRemoveFailed' as never)),
  })
  const directMutation = useMutation({
    mutationFn: (userID: string) => createDirectConversation(room.id, userID),
    onSuccess: conversation => {
      queryClient.invalidateQueries({ queryKey: ['rooms', 'direct-conversations'] }).catch(() => undefined)
      navigate({ to: '/rooms/direct/$conversationID', params: { conversationID: conversation.id } })
    },
    onError: () => toast.error(t('rooms.startDirectFailed')),
  })
  const canManage = room.current_role === 'owner' || room.current_role === 'moderator'

  const countLabel = membersQuery.data ? ` (${membersQuery.data.length})` : ''
  return <section aria-labelledby="room-members-heading">
    <div className="flex items-center justify-between gap-3">
      <h2 id="room-members-heading" className="text-base font-semibold text-zinc-950 dark:text-white">{t('rooms.members' as never)}{countLabel}</h2>
      {canManage && <AddPersonDialog room={room} />}
    </div>
    {membersQuery.isLoading && <p className="mt-4 text-sm text-muted">{t('rooms.loadingMembers' as never)}</p>}
    {membersQuery.isError && <p className="mt-4 text-sm text-red-600">{t('rooms.membersLoadFailed' as never)}</p>}
    <MemberList members={membersQuery.data ?? []} room={room} currentUserID={user?.id} onDirect={directMutation.mutate} onRemove={removeMutation.mutate} />
  </section>
}
