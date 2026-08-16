import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { listRoomInvites, revokeRoomInvite, type Room } from '@/lib/rooms'

export function RoomInvitesPanel({ room }: Readonly<{ room: Room }>) {
  const queryClient = useQueryClient()
  const canManage = room.current_role === 'owner' || room.current_role === 'moderator'
  const queryKey = ['rooms', room.id, 'invites']
  const invites = useQuery({ queryKey, queryFn: ({ signal }) => listRoomInvites(room.id, signal), enabled: canManage })
  const revoke = useMutation({ mutationFn: (inviteID: string) => revokeRoomInvite(room.id, inviteID), onSuccess: () => queryClient.invalidateQueries({ queryKey }), onError: () => toast.error('Invitationen kunne ikke tilbagekaldes.') })
  if (!canManage || !invites.data?.length) return null
  return <section className="mt-6 border-t border-zinc-200 pt-6 dark:border-[#2d3148]" aria-labelledby="room-invites-heading"><h2 id="room-invites-heading" className="mb-3 flex items-center gap-2 text-lg font-semibold"><Link2 size={18} /> Gæsteinvitationer</h2><div className="space-y-2">{invites.data.map(invite => { const active = !invite.revoked_at && new Date(invite.expires_at) > new Date(); return <div key={invite.id} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-[#2d3148]"><div><p className="font-medium">{invite.label || 'Gæsteinvitation'}</p><p className="text-xs text-muted">{active ? `Udløber ${new Date(invite.expires_at).toLocaleString()}` : 'Udløbet eller tilbagekaldt'} · Chat: {invite.can_chat ? 'ja' : 'nej'} · Upload: {invite.can_upload ? 'ja' : 'nej'}</p></div>{active && <button type="button" onClick={() => revoke.mutate(invite.id)} className="rounded-md p-2 text-red-600" aria-label="Tilbagekald invitation"><Trash2 size={16} /></button>}</div> })}</div></section>
}
