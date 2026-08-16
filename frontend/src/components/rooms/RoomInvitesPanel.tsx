import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Trash2, UserRoundX } from 'lucide-react'
import { toast } from 'sonner'
import { useI18n } from '@/lib/i18n'
import { listRoomGuestSessions, listRoomInvites, revokeRoomGuestSession, revokeRoomInvite, type Room, type RoomGuestSession, type RoomInvite } from '@/lib/rooms'

function InviteRow({ invite, onRevoke }: Readonly<{ invite: RoomInvite; onRevoke: (id: string) => void }>) {
  const { t, locale } = useI18n()
  const active = !invite.revoked_at && new Date(invite.expires_at) > new Date()
  return <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-[#2d3148]">
    <div><p className="font-medium">{invite.label || t('rooms.guestInvitation')}</p><p className="text-xs text-muted">{active ? t('rooms.expiresAt', { date: new Date(invite.expires_at).toLocaleString(locale === 'da' ? 'da-DK' : 'en-US') }) : t('rooms.expiredRevoked')} · {t('rooms.permissionSummary', { chat: t(invite.can_chat ? 'rooms.yes' : 'rooms.no'), upload: t(invite.can_upload ? 'rooms.yes' : 'rooms.no') })}</p></div>
    {active && <button type="button" onClick={() => onRevoke(invite.id)} className="rounded-md p-2 text-red-600" aria-label={t('rooms.revokeInvitation')}><Trash2 size={16} /></button>}
  </div>
}

function GuestSessionRow({ session, onRevoke }: Readonly<{ session: RoomGuestSession; onRevoke: (id: string) => void }>) {
  const { t, locale } = useI18n()
  const activity = session.last_accessed_at ?? session.created_at
  const name = session.display_name || t('rooms.unknownGuest')
  const dateLocale = locale === 'da' ? 'da-DK' : 'en-US'
  return <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-[#2d3148]">
    <div><p className="font-medium">{name}</p><p className="text-xs text-muted">{t('rooms.guestActivity', { active: new Date(activity).toLocaleString(dateLocale), expires: new Date(session.expires_at).toLocaleString(dateLocale) })}</p></div>
    <button type="button" onClick={() => onRevoke(session.id)} className="rounded-md p-2 text-red-600" aria-label={t('rooms.removeGuestAccess', { name })}><UserRoundX size={16} /></button>
  </div>
}

export function RoomInvitesPanel({ room }: Readonly<{ room: Room }>) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const canManage = room.current_role === 'owner' || room.current_role === 'moderator'
  const invitesKey = ['rooms', room.id, 'invites']
  const sessionsKey = ['rooms', room.id, 'guest-sessions']
  const invites = useQuery({ queryKey: invitesKey, queryFn: ({ signal }) => listRoomInvites(room.id, signal), enabled: canManage })
  const sessions = useQuery({ queryKey: sessionsKey, queryFn: ({ signal }) => listRoomGuestSessions(room.id, signal), enabled: canManage })
  const revokeInvite = useMutation({ mutationFn: (id: string) => revokeRoomInvite(room.id, id), onSuccess: () => { queryClient.invalidateQueries({ queryKey: invitesKey }); queryClient.invalidateQueries({ queryKey: sessionsKey }); toast.success(t('rooms.inviteRevoked')) }, onError: () => toast.error(t('rooms.inviteRevokeFailed')) })
  const revokeSession = useMutation({ mutationFn: (id: string) => revokeRoomGuestSession(room.id, id), onSuccess: () => { queryClient.invalidateQueries({ queryKey: sessionsKey }); toast.success(t('rooms.guestAccessRemoved')) }, onError: () => toast.error(t('rooms.guestRemoveFailed')) })
  if (!canManage || !(invites.data?.length || sessions.data?.length)) return null
  return <section className="mt-6 space-y-6 border-t border-zinc-200 pt-6 dark:border-[#2d3148]" aria-label={t('rooms.guestAccess')}>
    {!!sessions.data?.length && <div><h2 className="mb-3 flex items-center gap-2 text-lg font-semibold"><UserRoundX size={18} /> {t('rooms.activeGuests')}</h2><div className="space-y-2">{sessions.data.map(session => <GuestSessionRow key={session.id} session={session} onRevoke={revokeSession.mutate} />)}</div></div>}
    {!!invites.data?.length && <div><h2 className="mb-3 flex items-center gap-2 text-lg font-semibold"><Link2 size={18} /> {t('rooms.guestInvitations')}</h2><div className="space-y-2">{invites.data.map(invite => <InviteRow key={invite.id} invite={invite} onRevoke={revokeInvite.mutate} />)}</div></div>}
  </section>
}
