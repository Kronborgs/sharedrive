import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DoorOpen, LogOut, Send } from 'lucide-react'
import { createGuestRoomMessage, getGuestRoom, listGuestRoomMessages, logoutGuestRoom } from '@/lib/rooms'
import { GuestRoomLiveSync } from '@/components/rooms/GuestRoomLiveSync'
import { GuestRoomUpload } from '@/components/rooms/GuestRoomUpload'

export function GuestRoomPage({ roomID }: Readonly<{ roomID: string }>) {
  const queryClient = useQueryClient()
  const [body, setBody] = useState('')
  const queryKey = ['guest-room', roomID, 'messages']
  const room = useQuery({ queryKey: ['guest-room', roomID], queryFn: ({ signal }) => getGuestRoom(roomID, signal), retry: false })
  const messages = useQuery({ queryKey, queryFn: ({ signal }) => listGuestRoomMessages(roomID, signal), enabled: room.isSuccess, refetchInterval: 1500 })
  const send = useMutation({
    mutationFn: () => createGuestRoomMessage(roomID, body),
    onSuccess: () => { setBody(''); queryClient.invalidateQueries({ queryKey }).catch(() => undefined) },
  })
  if (room.isLoading) return <main className="min-h-screen bg-zinc-50 p-8 text-sm text-muted dark:bg-[#0f1117]">Åbner Room…</main>
  if (!room.data) return <main className="min-h-screen bg-zinc-50 p-8 dark:bg-[#0f1117]"><p className="mx-auto max-w-xl rounded-xl border border-red-200 p-5 text-red-700 dark:border-red-900 dark:text-red-400">Gæstesessionen er udløbet eller tilbagekaldt. Åbn invitationslinket igen.</p></main>

  return <main className="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-900 dark:bg-[#0f1117] dark:text-zinc-100">
    <div className="mx-auto max-w-4xl">
      <GuestRoomLiveSync roomID={roomID} />
      <header className="flex items-start justify-between border-b border-zinc-200 pb-5 dark:border-[#2d3148]">
        <div><h1 className="flex items-center gap-2 text-2xl font-semibold"><DoorOpen className="text-brand-600" /> {room.data.name}</h1><p className="mt-1 text-sm text-muted">Gæst: {room.data.display_name} · Adgang udløber {new Date(room.data.expires_at).toLocaleString()}</p></div>
        <button type="button" className="flex items-center gap-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-[#3a3f58]" onClick={() => logoutGuestRoom().finally(() => window.location.replace('/login'))}><LogOut size={15} /> Forlad</button>
      </header>
      <section className="mt-6" aria-label="Room chat">
        <h2 className="mb-3 text-lg font-semibold">Chat</h2>
        <div className="mb-3 max-h-[55vh] space-y-3 overflow-y-auto rounded-xl border border-zinc-200 p-3 dark:border-[#2d3148]">
          {messages.data?.messages.map(message => <article key={message.id} className="rounded-lg bg-white px-3 py-2 dark:bg-[#1a1d27]"><p className="text-sm font-medium">{message.sender_name}</p><p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-slate-300">{message.deleted_at ? 'Beskeden er slettet' : message.body}</p>{message.reactions?.length > 0 && <p className="mt-1 text-xs">{message.reactions.map(reaction => reaction.emoji).join(' ')}</p>}</article>)}
          {messages.data?.messages.length === 0 && <p className="text-sm text-muted">Ingen beskeder endnu.</p>}
        </div>
        {room.data.can_chat ? <form className="flex gap-2" onSubmit={event => { event.preventDefault(); if (body.trim()) send.mutate() }}><textarea value={body} onChange={event => setBody(event.target.value)} maxLength={10000} rows={2} placeholder="Skriv en besked…" className="min-h-12 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-[#3a3f58] dark:bg-[#151821]" /><button type="submit" disabled={!body.trim() || send.isPending} className="self-end rounded-lg bg-brand-600 p-2 text-white disabled:opacity-50" aria-label="Send besked"><Send size={18} /></button></form> : <p className="text-sm text-muted">Denne invitation giver kun læseadgang til chatten.</p>}
        {room.data.can_upload && <GuestRoomUpload roomID={roomID} maxFileBytes={room.data.upload_max_file_bytes} />}
      </section>
    </div>
  </main>
}
