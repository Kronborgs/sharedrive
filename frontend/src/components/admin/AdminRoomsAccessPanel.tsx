import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DoorOpen, Mail, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'

interface RoomAccount {
  id: string
  email: string
  display_name: string
  account_type: 'sharedrive' | 'rooms_only'
  access_enabled: boolean
  room_count: number
}

interface PendingRoomInvitation {
  id: string
  email: string
  room_id: string
  room_name: string
  role: 'member' | 'moderator'
  expires_at: string
}

interface ActiveRoomGuest {
  session_id: string
  display_name: string
  invitation: string
  room_id: string
  room_name: string
  expires_at: string
  last_accessed_at?: string
}

interface AdminRoomsOverview {
  accounts: RoomAccount[]
  pending_invitations: PendingRoomInvitation[]
  guests: ActiveRoomGuest[]
}

function EmptyRow({ children }: Readonly<{ children: string }>) {
  return <div className="rounded-lg border border-zinc-200 px-4 py-5 text-sm text-zinc-500 dark:border-[#2d3148] dark:text-slate-400">{children}</div>
}

function AccountRow({ account, onToggle, pending }: Readonly<{ account: RoomAccount; onToggle: (account: RoomAccount) => void; pending: boolean }>) {
  return <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-[#2d3148] dark:bg-[#1a1d27]">
    <UserRound size={18} className="text-brand-600" />
    <div className="min-w-48 flex-1"><p className="text-sm font-medium text-zinc-900 dark:text-slate-100">{account.display_name || account.email}</p><p className="text-xs text-zinc-500 dark:text-slate-400">{account.email}</p></div>
    <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-700 dark:bg-[#272b3a] dark:text-slate-300">{account.account_type === 'rooms_only' ? 'Kun Rooms' : 'Sharedrive + Rooms'}</span>
    <span className="w-20 text-right text-xs text-zinc-500 dark:text-slate-400">{account.room_count} Room{account.room_count === 1 ? '' : 's'}</span>
    <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-slate-300"><input type="checkbox" checked={account.access_enabled} disabled={pending} onChange={() => onToggle(account)} className="accent-brand-600" /> Rooms-adgang</label>
  </div>
}

export function AdminRoomsAccessPanel() {
  const queryClient = useQueryClient()
  const queryKey = ['admin', 'rooms-access']
  const overview = useQuery({ queryKey, queryFn: ({ signal }) => api.get<AdminRoomsOverview>('/api/v1/admin/rooms/access', signal) })
  const updateAccess = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/api/v1/admin/rooms/users/${id}/access`, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: () => toast.error('Rooms-adgangen kunne ikke ændres.'),
  })
  if (overview.isLoading) return <p className="py-8 text-center text-sm text-zinc-500 dark:text-slate-400">Indlæser Rooms-brugere…</p>
  if (!overview.data) return <p className="py-8 text-center text-sm text-red-600 dark:text-red-400">Rooms-brugerne kunne ikke indlæses.</p>
  const { accounts, pending_invitations: invitations, guests } = overview.data
  return <div className="space-y-8">
    <section><h2 className="mb-1 flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-slate-100"><DoorOpen size={18} /> Rooms-brugere</h2><p className="mb-3 text-sm text-zinc-500 dark:text-slate-400">Sharedrive-brugere og konti, der kun har adgang til Rooms.</p><div className="space-y-2">{accounts.length ? accounts.map(account => <AccountRow key={account.id} account={account} pending={updateAccess.isPending} onToggle={item => updateAccess.mutate({ id: item.id, enabled: !item.access_enabled })} />) : <EmptyRow>Ingen Rooms-brugere.</EmptyRow>}</div></section>
    <section><h2 className="mb-1 flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-slate-100"><Mail size={18} /> Afventende Rooms-invitationer</h2><p className="mb-3 text-sm text-zinc-500 dark:text-slate-400">Personer uden Sharedrive-konto, som er inviteret til at oprette en konto kun til Rooms.</p><div className="space-y-2">{invitations.length ? invitations.map(invitation => <div key={invitation.id} className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-[#2d3148] dark:bg-[#1a1d27]"><p className="text-sm font-medium text-zinc-900 dark:text-slate-100">{invitation.email}</p><p className="text-xs text-zinc-500 dark:text-slate-400">{invitation.room_name} · {invitation.role === 'moderator' ? 'Moderator' : 'Medlem'} · Udløber {new Date(invitation.expires_at).toLocaleString()}</p></div>) : <EmptyRow>Ingen afventende Rooms-invitationer.</EmptyRow>}</div></section>
    <section><h2 className="mb-1 flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-slate-100"><UserRound size={18} /> Aktive Room-gæster</h2><p className="mb-3 text-sm text-zinc-500 dark:text-slate-400">Midlertidige gæstesessioner oprettet via personlige Room-links.</p><div className="space-y-2">{guests.length ? guests.map(guest => <div key={guest.session_id} className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-[#2d3148] dark:bg-[#1a1d27]"><p className="text-sm font-medium text-zinc-900 dark:text-slate-100">{guest.display_name}</p><p className="text-xs text-zinc-500 dark:text-slate-400">{guest.room_name} · {guest.invitation || 'Gæsteinvitation'} · Udløber {new Date(guest.expires_at).toLocaleString()}</p></div>) : <EmptyRow>Ingen aktive Room-gæster.</EmptyRow>}</div></section>
  </div>
}
