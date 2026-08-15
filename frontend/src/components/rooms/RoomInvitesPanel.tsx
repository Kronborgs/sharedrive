import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Link2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { createRoomInvite, listRoomInvites, revokeRoomInvite, type Room } from '@/lib/rooms'

export function RoomInvitesPanel({ room }: Readonly<{ room: Room }>) {
  const queryClient = useQueryClient()
  const [label, setLabel] = useState('')
  const [expiresHours, setExpiresHours] = useState(24)
  const [canChat, setCanChat] = useState(true)
  const [canUpload, setCanUpload] = useState(false)
  const [canVoice, setCanVoice] = useState(false)
  const [canShareScreen, setCanShareScreen] = useState(false)
  const canManage = room.current_role === 'owner' || room.current_role === 'moderator'
  const queryKey = ['rooms', room.id, 'invites']
  const invites = useQuery({
    queryKey,
    queryFn: ({ signal }) => listRoomInvites(room.id, signal),
    enabled: canManage,
  })
  const create = useMutation({
    mutationFn: () => createRoomInvite(room.id, { label: label.trim(), expires_hours: expiresHours, can_chat: canChat, can_upload: canUpload, can_voice: canVoice, can_share_screen: canShareScreen }),
    onSuccess: async result => {
      setLabel('')
      await navigator.clipboard.writeText(result.invite_url)
      await queryClient.invalidateQueries({ queryKey })
      toast.success('Gæstelinket er oprettet og kopieret. Det vises kun denne ene gang.')
    },
    onError: () => toast.error('Gæstelinket kunne ikke oprettes.'),
  })
  const revoke = useMutation({
    mutationFn: (inviteID: string) => revokeRoomInvite(room.id, inviteID),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: () => toast.error('Invitationen kunne ikke tilbagekaldes.'),
  })

  if (!canManage) return null

  return (
    <section className="mt-6 border-t border-zinc-200 pt-6 dark:border-[#2d3148]" aria-labelledby="room-invites-heading">
      <h2 id="room-invites-heading" className="mb-1 flex items-center gap-2 text-lg font-semibold text-zinc-950 dark:text-white"><Link2 size={18} /> Gæsteadgang</h2>
      <p className="mb-4 text-sm text-muted">Opret et tidsbegrænset link. Linket kan kun kopieres, når det bliver oprettet.</p>
      <form className="grid gap-3 rounded-xl border border-zinc-200 p-4 dark:border-[#2d3148] sm:grid-cols-3" onSubmit={event => { event.preventDefault(); create.mutate() }}>
        <label className="text-sm sm:col-span-2"><span className="block">Navn på invitation</span>
          <input value={label} onChange={event => setLabel(event.target.value)} maxLength={120} placeholder="Fx Ekstern gæst" className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 dark:border-[#3a3f58] dark:bg-[#0f1117]" />
        </label>
        <label className="text-sm"><span className="block">Gyldig i timer</span>
          <input type="number" min={1} max={720} value={expiresHours} onChange={event => setExpiresHours(Number(event.target.value))} className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 dark:border-[#3a3f58] dark:bg-[#0f1117]" />
        </label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={canChat} onChange={event => setCanChat(event.target.checked)} /> Må skrive i chat</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={canUpload} onChange={event => setCanUpload(event.target.checked)} /> Må uploade filer</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={canVoice} onChange={event => setCanVoice(event.target.checked)} /> Må deltage i tale (Phase 5)</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={canShareScreen} onChange={event => setCanShareScreen(event.target.checked)} /> Må dele skærm (Phase 6)</label>
        <button type="submit" disabled={create.isPending || expiresHours < 1 || expiresHours > 720} className="rounded-lg bg-brand-600 px-3 py-2 text-sm text-white disabled:opacity-50">Opret og kopiér link</button>
      </form>
      <div className="mt-3 space-y-2">
        {invites.data?.map(invite => {
          const active = !invite.revoked_at && new Date(invite.expires_at) > new Date()
          return <div key={invite.id} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-[#2d3148]">
            <div><p className="font-medium">{invite.label || 'Gæsteinvitation'}</p><p className="text-xs text-muted">{active ? `Udløber ${new Date(invite.expires_at).toLocaleString()}` : 'Udløbet eller tilbagekaldt'} · Chat: {invite.can_chat ? 'ja' : 'nej'} · Upload: {invite.can_upload ? 'ja' : 'nej'} · Tale: {invite.can_voice ? 'ja' : 'nej'} · Skærm: {invite.can_share_screen ? 'ja' : 'nej'}</p></div>
            {active && <button type="button" onClick={() => revoke.mutate(invite.id)} disabled={revoke.isPending} className="rounded-md p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30" aria-label="Tilbagekald invitation"><Trash2 size={16} /></button>}
          </div>
        })}
        {invites.data?.length === 0 && <p className="text-sm text-muted">Ingen gæsteinvitationer endnu.</p>}
      </div>
      <p className="mt-3 flex items-center gap-1 text-xs text-muted"><Copy size={13} /> Gamle links kan ikke vises igen, fordi serveren kun gemmer et hash af tokenet.</p>
    </section>
  )
}
