import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Trash2, UserRoundX } from 'lucide-react'
import { toast } from 'sonner'
import { listRoomGuestSessions, listRoomInvites, revokeRoomGuestSession, revokeRoomInvite, type Room, type RoomGuestSession, type RoomInvite } from '@/lib/rooms'

function InviteRow({ invite, onRevoke }: Readonly<{ invite: RoomInvite; onRevoke: (id: string) => void }>) {
  const active = !invite.revoked_at && new Date(invite.expires_at) > new Date()
  return <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-[#2d3148]">
    <div><p className="font-medium">{invite.label || 'Gæsteinvitation'}</p><p className="text-xs text-muted">{active ? `Udløber ${new Date(invite.expires_at).toLocaleString()}` : 'Udløbet eller tilbagekaldt'} · Chat: {invite.can_chat ? 'ja' : 'nej'} · Upload: {invite.can_upload ? 'ja' : 'nej'}</p></div>
    {active && <button type="button" onClick={() => onRevoke(invite.id)} className="rounded-md p-2 text-red-600" aria-label="Tilbagekald invitation"><Trash2 size={16} /></button>}
  </div>
}

function GuestSessionRow({ session, onRevoke }: Readonly<{ session: RoomGuestSession; onRevoke: (id: string) => void }>) {
  const activity = session.last_accessed_at ?? session.created_at
  const name = session.display_name || 'Ukendt gæst'
  return <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-[#2d3148]">
    <div><p className="font-medium">{name}</p><p className="text-xs text-muted">Sidst aktiv {new Date(activity).toLocaleString()} · Udløber {new Date(session.expires_at).toLocaleString()}</p></div>
    <button type="button" onClick={() => onRevoke(session.id)} className="rounded-md p-2 text-red-600" aria-label={`Fjern adgang for ${name}`}><UserRoundX size={16} /></button>
  </div>
}

export function RoomInvitesPanel({ room }: Readonly<{ room: Room }>) {
  const queryClient = useQueryClient()
  const canManage = room.current_role === 'owner' || room.current_role === 'moderator'
  const invitesKey = ['rooms', room.id, 'invites']
  const sessionsKey = ['rooms', room.id, 'guest-sessions']
  const invites = useQuery({ queryKey: invitesKey, queryFn: ({ signal }) => listRoomInvites(room.id, signal), enabled: canManage })
  const sessions = useQuery({ queryKey: sessionsKey, queryFn: ({ signal }) => listRoomGuestSessions(room.id, signal), enabled: canManage })
  const revokeInvite = useMutation({ mutationFn: (id: string) => revokeRoomInvite(room.id, id), onSuccess: () => { queryClient.invalidateQueries({ queryKey: invitesKey }); queryClient.invalidateQueries({ queryKey: sessionsKey }); toast.success('Invitationen er tilbagekaldt.') }, onError: () => toast.error('Invitationen kunne ikke tilbagekaldes.') })
  const revokeSession = useMutation({ mutationFn: (id: string) => revokeRoomGuestSession(room.id, id), onSuccess: () => { queryClient.invalidateQueries({ queryKey: sessionsKey }); toast.success('Gæstens adgang er fjernet.') }, onError: () => toast.error('Gæstens adgang kunne ikke fjernes.') })
  if (!canManage || !(invites.data?.length || sessions.data?.length)) return null
  return <section className="mt-6 space-y-6 border-t border-zinc-200 pt-6 dark:border-[#2d3148]" aria-label="Gæsteadgang">
    {!!sessions.data?.length && <div><h2 className="mb-3 flex items-center gap-2 text-lg font-semibold"><UserRoundX size={18} /> Aktive gæster</h2><div className="space-y-2">{sessions.data.map(session => <GuestSessionRow key={session.id} session={session} onRevoke={revokeSession.mutate} />)}</div></div>}
    {!!invites.data?.length && <div><h2 className="mb-3 flex items-center gap-2 text-lg font-semibold"><Link2 size={18} /> Gæsteinvitationer</h2><div className="space-y-2">{invites.data.map(invite => <InviteRow key={invite.id} invite={invite} onRevoke={revokeInvite.mutate} />)}</div></div>}
  </section>
}
