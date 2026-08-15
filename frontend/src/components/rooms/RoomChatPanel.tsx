import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Pencil, Reply, Send, Trash2 } from 'lucide-react'
import { useAuth } from '@/lib/auth-context'
import { addRoomReaction, createRoomMessage, deleteRoomMessage, listRoomMessages, markRoomRead, removeRoomReaction, updateRoomMessage, type RoomMessage } from '@/lib/rooms'

export function RoomChatPanel({ roomID }: Readonly<{ roomID: string }>) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<RoomMessage>()
  const [typingName, setTypingName] = useState('')
  const socketRef = useRef<WebSocket | undefined>(undefined)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastTypingRef = useRef(0)
  const queryKey = ['rooms', roomID, 'messages']
  const messages = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => listRoomMessages(roomID, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.next_cursor,
  })
  const messageItems = messages.data?.pages.flatMap(page => page.messages) ?? []
  const refresh = () => queryClient.invalidateQueries({ queryKey }).catch(() => undefined)

  useEffect(() => {
    let stopped = false
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${scheme}//${window.location.host}/api/v1/rooms/${roomID}/messages/ws`)
      socketRef.current = socket
      socket.onmessage = event => {
        const update = JSON.parse(event.data) as { type: string; user_id?: string; display_name?: string }
        if (update.type === 'messages_changed') refresh()
        if (update.type === 'typing' && update.user_id !== user?.id) {
          setTypingName(update.display_name ?? '')
          if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
          typingTimerRef.current = setTimeout(() => setTypingName(''), 1800)
        }
      }
      socket.onclose = () => {
        socketRef.current = undefined
        if (!stopped) {
          retry = setTimeout(connect, 1500)
        }
      }
    }
    connect()
    return () => {
      stopped = true
      if (retry) {
        clearTimeout(retry)
      }
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current)
      }
      socket?.close()
    }
  }, [queryClient, roomID, user?.id])

  useEffect(() => {
    const newest = messages.data?.pages[0]?.messages[0]
    if (newest) {
      markRoomRead(roomID, newest.id).catch(() => undefined)
    }
  }, [messages.data, roomID])

  const notifyTyping = () => {
    const now = Date.now()
    if (now - lastTypingRef.current < 1000 || socketRef.current?.readyState !== WebSocket.OPEN) return
    lastTypingRef.current = now
    socketRef.current.send(JSON.stringify({ type: 'typing' }))
  }

  const send = useMutation({
    mutationFn: () => createRoomMessage(roomID, body, replyTo?.id),
    onSuccess: () => { setBody(''); setReplyTo(undefined); refresh() },
  })
  const edit = (message: RoomMessage) => {
    const next = window.prompt('Redigér besked', message.body)
    if (next?.trim() && next.trim() !== message.body) {
      updateRoomMessage(roomID, message.id, next.trim()).then(refresh).catch(() => undefined)
    }
  }
  const remove = (message: RoomMessage) => deleteRoomMessage(roomID, message.id).then(refresh).catch(() => undefined)
  const toggleReaction = (message: RoomMessage, emoji: string) => {
    const mine = message.reactions?.some(reaction => reaction.user_id === user?.id && reaction.emoji === emoji)
    const action = mine ? removeRoomReaction(roomID, message.id, emoji) : addRoomReaction(roomID, message.id, emoji)
    action.then(refresh).catch(() => undefined)
  }

  return (
    <section className="mt-6 border-t border-zinc-200 pt-6 dark:border-[#2d3148]" aria-label="Room chat">
      <h2 className="mb-3 text-lg font-semibold text-zinc-950 dark:text-white">Chat</h2>
      <div className="mb-3 max-h-96 space-y-3 overflow-y-auto rounded-xl border border-zinc-200 p-3 dark:border-[#2d3148]">
        {messages.isLoading && <p className="text-sm text-muted">Indlæser beskeder…</p>}
        {messageItems.length === 0 && <p className="text-sm text-muted">Ingen beskeder endnu.</p>}
        {messageItems.map(message => (
          <article key={message.id} className="rounded-lg bg-zinc-50 px-3 py-2 dark:bg-[#1a1d27]">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-zinc-900 dark:text-slate-100">{message.sender_name}</p>
              <div className="flex gap-2 text-muted">
                <button type="button" onClick={() => setReplyTo(message)} aria-label="Svar"><Reply size={14} /></button>
                {message.sender_user_id === user?.id && <><button type="button" onClick={() => edit(message)} aria-label="Redigér"><Pencil size={14} /></button><button type="button" onClick={() => remove(message)} aria-label="Slet"><Trash2 size={14} /></button></>}
              </div>
            </div>
            {message.reply_to_message_id && <p className="text-xs text-muted">Svar på en tidligere besked</p>}
            <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-slate-300">{message.deleted_at ? 'Beskeden er slettet' : message.body}</p>
            {!message.deleted_at && <div className="mt-2 flex gap-1">{['👍','❤️','😂'].map(emoji => <button key={emoji} type="button" onClick={() => toggleReaction(message, emoji)} className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs dark:border-[#3a3f58]">{emoji} {message.reactions?.filter(reaction => reaction.emoji === emoji).length || ''}</button>)}</div>}
          </article>
        ))}
        {messages.hasNextPage && (
          <button type="button" onClick={() => messages.fetchNextPage()} disabled={messages.isFetchingNextPage} className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-[#2d3148]">
            {messages.isFetchingNextPage ? 'Henter…' : 'Hent ældre beskeder'}
          </button>
        )}
      </div>
      {typingName && <p className="mb-2 text-xs text-muted">{typingName} skriver…</p>}
      {replyTo && <div className="mb-2 flex justify-between rounded-lg bg-zinc-100 px-3 py-2 text-xs dark:bg-[#1a1d27]"><span>Svarer til {replyTo.sender_name}</span><button type="button" onClick={() => setReplyTo(undefined)}>Annuller</button></div>}
      <form className="flex gap-2" onSubmit={event => {
        event.preventDefault()
        if (body.trim()) {
          send.mutate()
        }
      }}>
        <textarea value={body} onChange={event => { setBody(event.target.value); notifyTyping() }} maxLength={10000} rows={2} placeholder="Skriv en besked…" className="min-h-12 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-[#2d3148] dark:bg-[#0f1117]" />
        <button type="submit" disabled={!body.trim() || send.isPending} className="self-end rounded-lg bg-brand-600 p-2 text-white disabled:opacity-50" aria-label="Send besked"><Send size={18} /></button>
      </form>
    </section>
  )
}