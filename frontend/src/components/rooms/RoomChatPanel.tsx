import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { File, FileText, Pencil, Reply, Send, Trash2 } from 'lucide-react'
import { PreviewModal } from '@/components/files/PreviewModal'
import { EmojiPicker } from '@/components/rooms/EmojiPicker'
import { RoomResourcesPanel } from '@/components/rooms/RoomResourcesPanel'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { useI18n } from '@/lib/i18n'
import {
  addRoomReaction,
  createRoomMessage,
  deleteRoomMessage,
  listRoomMessages,
  listRoomResources,
  markRoomRead,
  removeRoomReaction,
  removeRoomResource,
  updateRoomMessage,
  summarizeRoomReactions,
  type Room,
  type RoomMessage,
  type RoomResource,
} from '@/lib/rooms'
import type { FileItem } from '@/types/api'

type TimelineItem =
  | { kind: 'message'; date: string; value: RoomMessage }
  | { kind: 'resource'; date: string; value: RoomResource }

interface MessageCardProps {
  message: RoomMessage
  currentUserID?: string
  canModerate: boolean
  onReply: (message: RoomMessage) => void
  onEdit: (message: RoomMessage) => void
  onDelete: (message: RoomMessage) => void
  onReaction: (message: RoomMessage, emoji: string) => void
}

function MessageActions({ message, currentUserID, canModerate, onReply, onEdit, onDelete }: Readonly<Omit<MessageCardProps, 'onReaction'>>) {
  const { t } = useI18n()
  const isAuthor = message.sender_user_id === currentUserID
  const canChange = !message.deleted_at

  return <div className="flex items-center gap-1 text-muted">
    <button type="button" onClick={() => onReply(message)} aria-label={t('rooms.reply')}><Reply size={14} /></button>
    {canChange && isAuthor && <button type="button" onClick={() => onEdit(message)} aria-label={t('rooms.edit')}><Pencil size={14} /></button>}
    {canChange && (isAuthor || canModerate) && <button type="button" onClick={() => onDelete(message)} aria-label={t('rooms.delete')}><Trash2 size={14} /></button>}
  </div>
}

function MessageCard(props: Readonly<MessageCardProps>) {
  const { t, locale } = useI18n()
  const { message, currentUserID, canModerate, onReply, onEdit, onDelete, onReaction } = props
  const deleted = Boolean(message.deleted_at)

  return <article className="rounded-lg bg-zinc-50 px-3 py-2 dark:bg-[#1a1d27]">
    <div className="flex items-center justify-between gap-2">
      <p className="text-sm font-medium">{message.sender_name}</p>
      <div className="flex items-center gap-2"><time dateTime={message.created_at} className="text-[11px] text-muted">{new Intl.DateTimeFormat(locale === 'da' ? 'da-DK' : 'en-US', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(message.created_at))}</time><MessageActions message={message} currentUserID={currentUserID} canModerate={canModerate} onReply={onReply} onEdit={onEdit} onDelete={onDelete} /></div>
    </div>
    {message.reply_to_message_id && <p className="text-xs text-muted">{t('rooms.replyContext')}</p>}
    <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-slate-300">{deleted ? t('rooms.messageDeleted') : message.body}</p>
    {!deleted && <div className="mt-2 flex flex-wrap items-center gap-1">
      {summarizeRoomReactions(message.reactions).map(summary => <button key={summary.emoji} type="button" onClick={() => onReaction(message, summary.emoji)} title={t('rooms.reactedBy', { names: summary.names.join(', ') })} aria-label={t('rooms.reactionAria', { emoji: summary.emoji, names: summary.names.join(', ') })} className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs dark:border-[#3a3f58]">{summary.emoji} {summary.count}</button>)}
      <EmojiPicker userKey={currentUserID ?? 'anonymous'} label={t('rooms.addReaction')} onSelect={emoji => onReaction(message, emoji)} />
    </div>}
  </article>
}

function ResourceName({ resource, onPreview }: Readonly<{ resource: RoomResource; onPreview: (id: string) => void }>) {
  const { t } = useI18n()
  if (!resource.accessible) return <p className="text-sm">{t('rooms.accessRequired')}</p>
  if (resource.resource_type === 'file') {
    return <button type="button" onClick={() => onPreview(resource.resource_id)} className="truncate text-left text-sm font-medium text-brand-600 hover:underline">{resource.name}</button>
  }
  return <a href={`/notes/${resource.resource_id}`} className="truncate text-sm font-medium text-brand-600 hover:underline">{resource.name}</a>
}

function isImageResource(resource: RoomResource) {
  if (resource.mime_type?.startsWith('image/')) return true
  return /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(resource.name ?? '')
}

function ResourceCard({ resource, canModerate, onPreview, onRemove }: Readonly<{ resource: RoomResource; canModerate: boolean; onPreview: (id: string) => void; onRemove: (id: string) => void }>) {
  const { t } = useI18n()
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  const showThumbnail = resource.accessible && resource.resource_type === 'file' && isImageResource(resource) && !thumbnailFailed

  if (showThumbnail) {
    return <article className="group relative w-fit max-w-[min(22rem,85%)]">
      <button type="button" onClick={() => onPreview(resource.resource_id)} className="block overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-950 dark:border-[#34394f]" title={resource.name}>
        <img src={`/api/v1/files/${resource.resource_id}/thumbnail`} alt={resource.name || t('rooms.sharedImage')} className="max-h-52 min-h-24 max-w-full object-contain" loading="lazy" onError={() => setThumbnailFailed(true)} />
      </button>
      {canModerate && <button type="button" onClick={() => onRemove(resource.id)} aria-label={t('rooms.removeImage')} className="absolute right-2 top-2 rounded-full bg-black/70 p-1.5 text-white opacity-80 shadow hover:bg-red-600 hover:opacity-100"><Trash2 size={14} /></button>}
      <span className="sr-only">{resource.name}</span>
    </article>
  }

  const isFile = resource.resource_type === 'file'
  return <article className="flex max-w-md items-center gap-3 rounded-2xl border border-zinc-200 bg-white px-3 py-3 shadow-sm dark:border-[#34394f] dark:bg-[#1a1d27]">
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-600 dark:bg-[#272b3a] dark:text-slate-300">{isFile ? <File size={20} /> : <FileText size={20} />}</span>
    <div className="min-w-0 flex-1"><ResourceName resource={resource} onPreview={onPreview} /><p className="text-xs text-muted">{t(isFile ? 'rooms.fileShared' : 'rooms.noteShared')}</p></div>
    {canModerate && <button type="button" onClick={() => onRemove(resource.id)} aria-label={t('rooms.removeFromChat')} className="rounded-full p-1.5 text-muted hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30"><Trash2 size={15} /></button>}
  </article>
}
function useRoomLiveSync(roomID: string, currentUserID: string | undefined, refresh: () => void) {
  const [typingName, setTypingName] = useState('')
  const socketRef = useRef<WebSocket | undefined>(undefined)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastTypingRef = useRef(0)

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
        if (update.type !== 'typing' || update.user_id === currentUserID) return
        setTypingName(update.display_name ?? '')
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
        typingTimerRef.current = setTimeout(() => setTypingName(''), 1800)
      }
      socket.onclose = () => {
        socketRef.current = undefined
        if (!stopped) retry = setTimeout(connect, 1500)
      }
    }

    connect()
    return () => {
      stopped = true
      if (retry) clearTimeout(retry)
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
      socket?.close()
    }
  }, [currentUserID, refresh, roomID])

  const notifyTyping = () => {
    const now = Date.now()
    if (now - lastTypingRef.current < 1000 || socketRef.current?.readyState !== WebSocket.OPEN) return
    lastTypingRef.current = now
    socketRef.current.send(JSON.stringify({ type: 'typing' }))
  }

  return { notifyTyping, typingName }
}

export function RoomChatPanel({ room }: Readonly<{ room: Room }>) {
  const { t } = useI18n()
  const roomID = room.id
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<RoomMessage>()
  const [previewID, setPreviewID] = useState<string>()
  const messageQueryKey = useMemo(() => ['rooms', roomID, 'messages'], [roomID])
  const resourceQueryKey = useMemo(() => ['rooms', roomID, 'resources'], [roomID])
  const refresh = useCallback(() => {
    Promise.all([
      queryClient.invalidateQueries({ queryKey: messageQueryKey }),
      queryClient.invalidateQueries({ queryKey: resourceQueryKey }),
      queryClient.invalidateQueries({ queryKey: ['rooms'] }),
    ]).catch(() => undefined)
  }, [messageQueryKey, queryClient, resourceQueryKey])
  const { notifyTyping, typingName } = useRoomLiveSync(roomID, user?.id, refresh)
  const messages = useInfiniteQuery({ queryKey: messageQueryKey, queryFn: ({ pageParam, signal }) => listRoomMessages(roomID, pageParam, signal), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.next_cursor })
  const resources = useQuery({ queryKey: resourceQueryKey, queryFn: ({ signal }) => listRoomResources(roomID, signal) })
  const preview = useQuery({ queryKey: ['rooms', roomID, 'preview-file', previewID], queryFn: ({ signal }) => api.get<FileItem>(`/api/v1/files/${previewID}`, signal), enabled: Boolean(previewID) })
  const messageItems = messages.data?.pages.flatMap(page => page.messages) ?? []
  const canModerate = user?.role === 'admin' || room.current_role === 'owner' || room.current_role === 'moderator'
  const timeline = useMemo<TimelineItem[]>(() => [
    ...messageItems.map(value => ({ kind: 'message' as const, date: value.created_at, value })),
    ...(resources.data ?? []).map(value => ({ kind: 'resource' as const, date: value.created_at, value })),
  ].sort((a, b) => b.date.localeCompare(a.date)), [messageItems, resources.data])

  useEffect(() => {
    const newest = messages.data?.pages[0]?.messages[0]
    if (newest) {
      markRoomRead(roomID, newest.id)
        .then(() => queryClient.invalidateQueries({ queryKey: ['rooms'] }))
        .catch(() => undefined)
    }
  }, [messages.data, queryClient, roomID])

  const send = useMutation({ mutationFn: () => createRoomMessage(roomID, body, replyTo?.id), onSuccess: () => { setBody(''); setReplyTo(undefined); refresh() } })
  const removeResourceMutation = useMutation({ mutationFn: (resourceID: string) => removeRoomResource(roomID, resourceID), onSuccess: refresh })
  const editMessage = (message: RoomMessage) => {
    const next = window.prompt(t('rooms.editMessagePrompt'), message.body)?.trim()
    if (next && next !== message.body) updateRoomMessage(roomID, message.id, next).then(refresh).catch(() => undefined)
  }
  const removeMessage = (message: RoomMessage) => deleteRoomMessage(roomID, message.id).then(refresh).catch(() => undefined)
  const toggleReaction = (message: RoomMessage, emoji: string) => {
    const mine = message.reactions?.some(reaction => reaction.user_id === user?.id && reaction.emoji === emoji)
    const action = mine ? removeRoomReaction(roomID, message.id, emoji) : addRoomReaction(roomID, message.id, emoji)
    action.then(refresh).catch(() => undefined)
  }

  return <section className="mt-6 border-t border-zinc-200 pt-6 dark:border-[#2d3148]" aria-label={t('rooms.chatAria')}>
    <h2 className="mb-3 text-lg font-semibold">{t('rooms.chat')}</h2>
    <div className="mb-3 max-h-[60vh] space-y-3 overflow-y-auto rounded-xl border border-zinc-200 p-3 dark:border-[#2d3148]">
      {messages.isLoading && <p className="text-sm text-muted">{t('rooms.chatLoading')}</p>}
      {timeline.length === 0 && <p className="text-sm text-muted">{t('rooms.chatEmpty')}</p>}
      {timeline.map(item => item.kind === 'message'
        ? <MessageCard key={`message-${item.value.id}`} message={item.value} currentUserID={user?.id} canModerate={canModerate} onReply={setReplyTo} onEdit={editMessage} onDelete={removeMessage} onReaction={toggleReaction} />
        : <ResourceCard key={`resource-${item.value.id}`} resource={item.value} canModerate={canModerate} onPreview={setPreviewID} onRemove={removeResourceMutation.mutate} />)}
      {messages.hasNextPage && <button type="button" onClick={() => messages.fetchNextPage()} className="w-full rounded-lg border px-3 py-2 text-sm">{t('rooms.loadOlder')}</button>}
    </div>
    {typingName && <p className="mb-2 text-xs text-muted">{t('rooms.typing', { name: typingName })}</p>}
    {replyTo && <div className="mb-2 flex justify-between rounded-lg bg-zinc-100 px-3 py-2 text-xs dark:bg-[#1a1d27]"><span>{t('rooms.replyingTo', { name: replyTo.sender_name })}</span><button type="button" onClick={() => setReplyTo(undefined)}>{t('action.cancel')}</button></div>}
    <form className="flex items-end gap-1 rounded-2xl border border-zinc-200 bg-white p-1.5 dark:border-[#2d3148] dark:bg-[#0f1117]" onSubmit={event => { event.preventDefault(); if (body.trim()) send.mutate() }}>
      <RoomResourcesPanel room={room} />
      <textarea value={body} onChange={event => { setBody(event.target.value); notifyTyping() }} maxLength={10000} rows={2} placeholder={t('rooms.messagePlaceholder')} className="min-h-11 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none" />
      <EmojiPicker userKey={user?.id ?? 'anonymous'} onSelect={emoji => setBody(value => value + emoji)} />
      <button type="submit" disabled={!body.trim() || send.isPending} className="rounded-full bg-brand-600 p-2.5 text-white disabled:opacity-50" aria-label={t('rooms.sendMessage')}><Send size={18} /></button>
    </form>
    {previewID && preview.data && <PreviewModal item={preview.data} onClose={() => setPreviewID(undefined)} />}
  </section>
}
