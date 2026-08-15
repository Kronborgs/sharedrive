import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { createRoomMessage, listRoomMessages } from '@/lib/rooms'

export function RoomChatPanel({ roomID }: Readonly<{ roomID: string }>) {
  const queryClient = useQueryClient()
  const [body, setBody] = useState('')
  const messages = useQuery({
    queryKey: ['rooms', roomID, 'messages'],
    queryFn: ({ signal }) => listRoomMessages(roomID, signal),
  })
  const send = useMutation({
    mutationFn: () => createRoomMessage(roomID, body),
    onSuccess: () => {
      setBody('')
      queryClient.invalidateQueries({ queryKey: ['rooms', roomID, 'messages'] }).catch(() => undefined)
    },
  })

  return (
    <section className="mt-6 border-t border-zinc-200 pt-6 dark:border-[#2d3148]" aria-label="Room chat">
      <h2 className="mb-3 text-lg font-semibold text-zinc-950 dark:text-white">Chat</h2>
      <div className="mb-3 max-h-96 space-y-3 overflow-y-auto rounded-xl border border-zinc-200 p-3 dark:border-[#2d3148]">
        {messages.isLoading && <p className="text-sm text-muted">Indlæser beskeder…</p>}
        {messages.data?.messages.length === 0 && <p className="text-sm text-muted">Ingen beskeder endnu.</p>}
        {messages.data?.messages.map(message => (
          <article key={message.id} className="rounded-lg bg-zinc-50 px-3 py-2 dark:bg-[#1a1d27]">
            <p className="text-sm font-medium text-zinc-900 dark:text-slate-100">{message.sender_name}</p>
            <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-slate-300">{message.body}</p>
          </article>
        ))}
      </div>
      <form className="flex gap-2" onSubmit={event => { event.preventDefault(); if (body.trim()) send.mutate() }}>
        <textarea value={body} onChange={event => setBody(event.target.value)} maxLength={10000} rows={2} placeholder="Skriv en besked…" className="min-h-12 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-[#2d3148] dark:bg-[#0f1117]" />
        <button type="submit" disabled={!body.trim() || send.isPending} className="self-end rounded-lg bg-brand-600 p-2 text-white disabled:opacity-50" aria-label="Send besked"><Send size={18} /></button>
      </form>
    </section>
  )
}
