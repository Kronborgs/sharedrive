import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { ArrowDown, File, FileText, Pencil, Reply, Send, Trash2 } from 'lucide-react'
import { PreviewModal } from '@/components/files/PreviewModal'
import { OnlyOfficeEditor } from '@/components/files/OnlyOfficeEditor'
import { EmojiPicker } from '@/components/rooms/EmojiPicker'
import { GifPicker } from '@/components/rooms/GifPicker'
import { RoomResourcesPanel, type PendingRoomResource } from '@/components/rooms/RoomResourcesPanel'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { useI18n } from '@/lib/i18n'
import { chatDayKey, formatChatDay, formatChatMessageTime } from '@/lib/room-dates'
import { importRemoteGIF, isRemoteGIFURL } from '@/lib/rooms-gifs'
import { shouldOpenInOnlyOffice } from '@/lib/file-types'
import {
  addRoomReaction,
  addRoomResource,
  createDirectConversation,
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
  groupedWithPrevious: boolean
  resources: RoomResource[]
  onReply: (message: RoomMessage) => void
  onEdit: (message: RoomMessage) => void
  onDelete: (message: RoomMessage) => void
  onReaction: (message: RoomMessage, emoji: string) => void
  onRemoveResource: (resourceID: string) => void
  onPreviewResource: (resourceID: string) => void
  onStartDirect: (userID: string) => void
}

function MessageActions({ message, currentUserID, canModerate, onReply, onEdit, onDelete }: Readonly<Omit<MessageCardProps, 'onReaction' | 'groupedWithPrevious' | 'resources' | 'onRemoveResource' | 'onPreviewResource' | 'onStartDirect'>>) {
  const { t } = useI18n()
  const isAuthor = message.sender_user_id === currentUserID
  const canChange = !message.deleted_at

  return <div className="flex items-center gap-1 text-muted opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
    <button type="button" onClick={() => onReply(message)} aria-label={t('rooms.reply')}><Reply size={14} /></button>
    {canChange && isAuthor && <button type="button" onClick={() => onEdit(message)} aria-label={t('rooms.edit')}><Pencil size={14} /></button>}
    {canChange && (isAuthor || canModerate) && <button type="button" onClick={() => onDelete(message)} aria-label={t('rooms.delete')}><Trash2 size={14} /></button>}
  </div>
}

function MessageCard(props: Readonly<MessageCardProps>) {
  const { t, locale } = useI18n()
  const { message, currentUserID, canModerate, groupedWithPrevious, resources, onReply, onEdit, onDelete, onReaction, onRemoveResource, onPreviewResource, onStartDirect } = props
  const deleted = Boolean(message.deleted_at)
  const isOwnMessage = message.sender_user_id === currentUserID
  const alignmentClass = isOwnMessage ? 'items-end self-end text-right' : 'items-start self-start text-left'
  const bubbleClass = isOwnMessage
    ? 'bg-brand-50 dark:bg-brand-900/30'
    : 'bg-surface'

  const hideBody = !deleted && resources.some(resource => resource.mime_type === 'image/gif') && isRemoteGIFURL(message.body)
  const showSender = !groupedWithPrevious || resources.some(isAnimatedGIF)
  return <article className={`group flex max-w-[70%] flex-col ${alignmentClass} ${groupedWithPrevious ? 'mt-1' : 'mt-3'}`}>
    {showSender && <div className={`mb-1 flex items-center gap-2 px-1 ${isOwnMessage ? 'justify-end' : 'justify-start'}`}>
      {message.sender_user_id && !isOwnMessage ? <button type="button" onClick={() => onStartDirect(message.sender_user_id!)} className="text-sm font-medium hover:text-brand-600 hover:underline" title={t('rooms.startDirect', { name: message.sender_name })}>{message.sender_name}</button> : <p className="text-sm font-medium">{message.sender_name}</p>}
      <div className="flex items-center gap-2"><time dateTime={message.created_at} className="text-[11px] text-muted">{formatChatMessageTime(message.created_at, locale)}</time><MessageActions message={message} currentUserID={currentUserID} canModerate={canModerate} onReply={onReply} onEdit={onEdit} onDelete={onDelete} /></div>
    </div>}
    <div className={`w-fit max-w-full rounded-2xl px-3 py-2 ${bubbleClass}`}>
    {!showSender && <div className="flex justify-end"><MessageActions message={message} currentUserID={currentUserID} canModerate={canModerate} onReply={onReply} onEdit={onEdit} onDelete={onDelete} /></div>}
    {message.reply_to_message_id && <p className="text-xs text-muted">{t('rooms.replyContext')}</p>}
    {!hideBody && <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-slate-300">{deleted ? t('rooms.messageDeleted') : message.body}</p>}
    {!deleted && resources.length > 0 && <div className="mt-2 space-y-2">{resources.map(resource => <ResourceCard key={resource.id} resource={resource} canModerate={canModerate} onPreview={onPreviewResource} onRemove={onRemoveResource} />)}</div>}
    {!deleted && <div className="mt-2 flex flex-wrap items-center gap-1">
      {summarizeRoomReactions(message.reactions).map(summary => <button key={summary.emoji} type="button" onClick={() => onReaction(message, summary.emoji)} title={t('rooms.reactedBy', { names: summary.names.join(', ') })} aria-label={t('rooms.reactionAria', { emoji: summary.emoji, names: summary.names.join(', ') })} className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs dark:border-[#3a3f58]">{summary.emoji} {summary.count}</button>)}
      <EmojiPicker userKey={currentUserID ?? 'anonymous'} label={t('rooms.addReaction')} onSelect={emoji => onReaction(message, emoji)} />
    </div>}
    </div>
  </article>
}

function isGroupedMessage(timeline: TimelineItem[], index: number) {
  const item = timeline[index]
  const previous = timeline[index - 1]
  if (item?.kind !== 'message' || previous?.kind !== 'message') return false
  const sameSender = item.value.sender_user_id === previous.value.sender_user_id && item.value.sender_guest_session_id === previous.value.sender_guest_session_id
  const millisecondsBetween = new Date(item.value.created_at).getTime() - new Date(previous.value.created_at).getTime()
  return sameSender && millisecondsBetween >= 0 && millisecondsBetween <= 300_000
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

function isAnimatedGIF(resource: RoomResource) {
  return resource.mime_type === 'image/gif' || /\.gif$/i.test(resource.name ?? '')
}

function ResourceCard({ resource, canModerate, onPreview, onRemove }: Readonly<{ resource: RoomResource; canModerate: boolean; onPreview: (id: string) => void; onRemove: (id: string) => void }>) {
  const { t } = useI18n()
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  const showThumbnail = resource.accessible && resource.resource_type === 'file' && isImageResource(resource) && !thumbnailFailed

  if (showThumbnail) {
    return <article className="group relative w-fit max-w-[min(22rem,85%)]">
      <button type="button" onClick={() => onPreview(resource.resource_id)} className="block overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-950 dark:border-[#34394f]" title={resource.name}>
        <img src={`/api/v1/files/${resource.resource_id}/${isAnimatedGIF(resource) ? 'preview' : 'thumbnail'}`} alt={resource.name || t('rooms.sharedImage')} className="max-h-52 min-h-24 max-w-full object-contain" loading="lazy" onError={() => setThumbnailFailed(true)} />
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
function StandaloneResourceCard({ resource, currentUserID, canModerate, onPreview, onRemove, onStartDirect }: Readonly<{ resource: RoomResource; currentUserID?: string; canModerate: boolean; onPreview: (id: string) => void; onRemove: (id: string) => void; onStartDirect: (userID: string) => void }>) {
  const { t, locale } = useI18n()
  const isOwnResource = resource.added_by === currentUserID
  const canStartDirect = Boolean(resource.added_by && !isOwnResource)
  const alignmentClass = isOwnResource ? 'items-end self-end text-right' : 'items-start self-start text-left'
  const senderName = resource.added_by_name || t('rooms.unknownSender' as never)

  return <article className={`mt-3 flex max-w-[70%] flex-col ${alignmentClass}`}>
    <div className={`mb-1 flex items-center gap-2 px-1 ${isOwnResource ? 'justify-end' : 'justify-start'}`}>
      {canStartDirect ? <button type="button" onClick={() => onStartDirect(resource.added_by!)} className="text-sm font-medium hover:text-brand-600 hover:underline" title={t('rooms.startDirect', { name: senderName })}>{senderName}</button> : <p className="text-sm font-medium">{senderName}</p>}
      <time dateTime={resource.created_at} className="text-[11px] text-muted">{formatChatMessageTime(resource.created_at, locale)}</time>
    </div>
    <ResourceCard resource={resource} canModerate={canModerate} onPreview={onPreview} onRemove={onRemove} />
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

export function RoomChatPanel({ room, fillAvailableHeight = false }: Readonly<{ room: Room; fillAvailableHeight?: boolean }>) {
  const { t, locale } = useI18n()
  const roomID = room.id
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<RoomMessage>()
  const [previewID, setPreviewID] = useState<string>()
  const [ooItem, setOoItem] = useState<FileItem>()
  const [attachments, setAttachments] = useState<PendingRoomResource[]>([])
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const newestTimelineID = useRef<string | undefined>(undefined)
  const scrollAfterSend = useRef(false)
  const wasAtBottom = useRef(true)
  const [hasNewMessagesBelow, setHasNewMessagesBelow] = useState(false)
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
  const preview = useQuery({ queryKey: ['rooms', roomID, 'preview-file', previewID], queryFn: ({ signal }) => api.get<FileItem>('/api/v1/files/' + previewID, signal), enabled: Boolean(previewID) })
  const systemSettings = useQuery({ queryKey: ['system', 'settings'], queryFn: ({ signal }) => api.get<{ onlyoffice_url?: string }>('/api/v1/system/settings', signal) })
  const openResource = useCallback((file: FileItem) => {
    if (systemSettings.data?.onlyoffice_url && shouldOpenInOnlyOffice(file.name)) {
      setOoItem(file)
      setPreviewID(undefined)
      return
    }
    setPreviewID(file.id)
  }, [systemSettings.data?.onlyoffice_url])
  const openResourceByID = useCallback((resourceID: string) => {
    const resource = (resources.data ?? []).find(item => item.resource_id === resourceID && item.resource_type === 'file')
    if (!resource) { setPreviewID(resourceID); return }
    openResource({ id: resource.resource_id, parent_id: null, owner_id: '', is_folder: false, name: resource.name ?? 'shared-file', mime_type: resource.mime_type ?? null, size_bytes: 0, checksum_sha256: null, deleted_at: null, created_at: resource.created_at, updated_at: resource.created_at })
  }, [openResource, resources.data])
  const messageItems = messages.data?.pages.flatMap(page => page.messages) ?? []
  const canModerate = user?.role === 'admin' || room.current_role === 'owner' || room.current_role === 'moderator'
  const resourcesByMessage = useMemo(() => {
    const result = new Map<string, RoomResource[]>()
    for (const resource of resources.data ?? []) {
      if (!resource.message_id) continue
      result.set(resource.message_id, [...(result.get(resource.message_id) ?? []), resource])
    }
    return result
  }, [resources.data])
  const timeline = useMemo<TimelineItem[]>(() => [
    ...messageItems.map(value => ({ kind: 'message' as const, date: value.created_at, value })),
    ...(resources.data ?? []).filter(value => !value.message_id).map(value => ({ kind: 'resource' as const, date: value.created_at, value })),
  ].sort((a, b) => a.date.localeCompare(b.date)), [messageItems, resources.data])

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const container = chatScrollRef.current
    if (!container) return
    container.scrollTo({ top: container.scrollHeight, behavior })
    wasAtBottom.current = true
    setHasNewMessagesBelow(false)
  }, [])

  const handleChatScroll = useCallback(() => {
    const container = chatScrollRef.current
    if (!container) return
    wasAtBottom.current = container.scrollHeight - container.scrollTop - container.clientHeight <= 48
    if (wasAtBottom.current) setHasNewMessagesBelow(false)
  }, [])

  useEffect(() => {
    const container = chatScrollRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (wasAtBottom.current) requestAnimationFrame(() => scrollToLatest('auto'))
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [scrollToLatest])

  useEffect(() => {
    const latest = timeline.at(-1)
    if (!latest) return
    const latestID = `${latest.kind}-${latest.value.id}`
    const previousID = newestTimelineID.current
    newestTimelineID.current = latestID
    if (!previousID) {
      requestAnimationFrame(() => scrollToLatest(previousID ? 'smooth' : 'auto'))
      return
    }
    if (previousID === latestID) return
    if (scrollAfterSend.current || wasAtBottom.current) {
      scrollAfterSend.current = false
      requestAnimationFrame(() => scrollToLatest())
      return
    }
    setHasNewMessagesBelow(true)
  }, [scrollToLatest, timeline])

  useEffect(() => {
    if (timeline.length === 0) return
    const settleAtLatest = () => { if (wasAtBottom.current) scrollToLatest('auto') }
    const frame = requestAnimationFrame(() => requestAnimationFrame(settleAtLatest))
    const timer = window.setTimeout(settleAtLatest, 150)
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer) }
  }, [roomID, scrollToLatest, timeline.length])

  useEffect(() => {
    const newest = messages.data?.pages[0]?.messages[0]
    if (newest) {
      markRoomRead(roomID, newest.id)
        .then(() => queryClient.invalidateQueries({ queryKey: ['rooms'] }))
        .catch(() => undefined)
    }
  }, [messages.data, queryClient, roomID])

  const send = useMutation({ mutationFn: async () => {
    if (attachments.length === 0 && isRemoteGIFURL(body)) {
      const gif = await importRemoteGIF(body)
      const message = await createRoomMessage(roomID, body.trim(), replyTo?.id)
      await addRoomResource(roomID, 'file', gif.file_id, message.id)
      return message
    }
    if (!body.trim()) {
      await Promise.all(attachments.map(attachment => addRoomResource(roomID, attachment.resourceType, attachment.resourceID)))
      return undefined
    }
    const message = await createRoomMessage(roomID, body, replyTo?.id)
    await Promise.all(attachments.map(attachment => addRoomResource(roomID, attachment.resourceType, attachment.resourceID, message.id)))
    return message
  }, onSuccess: () => { scrollAfterSend.current = true; setBody(''); setAttachments([]); setReplyTo(undefined); refresh() } })
  const sendGIF = useMutation({ mutationFn: async ({ fileID, name }: { fileID: string; name: string }) => { const message = await createRoomMessage(roomID, name); await addRoomResource(roomID, 'file', fileID, message.id) }, onSuccess: () => { scrollAfterSend.current = true; refresh() } })
  const removeResourceMutation = useMutation({ mutationFn: (resourceID: string) => removeRoomResource(roomID, resourceID), onSuccess: refresh })
  const directMutation = useMutation({ mutationFn: (userID: string) => createDirectConversation(roomID, userID), onSuccess: conversation => { queryClient.invalidateQueries({ queryKey: ['rooms', 'direct-conversations'] }).catch(() => undefined); navigate({ to: '/rooms/direct/$conversationID', params: { conversationID: conversation.id } }).catch(() => undefined) }, onError: () => toast.error(t('rooms.startDirectFailed')) })
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

  const panelClass = fillAvailableHeight ? 'flex min-h-0 flex-1 flex-col' : 'mt-6 border-t border-zinc-200 pt-6 dark:border-[#2d3148]'
  const timelineClass = fillAvailableHeight ? 'flex min-h-0 flex-1 flex-col overflow-y-auto rounded-xl border border-subtle p-3' : 'flex max-h-[60vh] flex-col overflow-y-auto rounded-xl border border-subtle p-3'

  return <section className={panelClass} aria-label={t('rooms.chatAria')}>
    <div className={fillAvailableHeight ? 'relative flex min-h-0 flex-1 flex-col py-3' : 'relative mb-3'}>
    <div ref={chatScrollRef} onScroll={handleChatScroll} onLoadCapture={() => { if (wasAtBottom.current) requestAnimationFrame(() => scrollToLatest('auto')) }} className={timelineClass}>
      {messages.isLoading && <p className="text-sm text-muted">{t('rooms.chatLoading')}</p>}
      {timeline.length === 0 && <p className="text-sm text-muted">{t('rooms.chatEmpty')}</p>}
      {messages.hasNextPage && <button type="button" onClick={() => messages.fetchNextPage()} className="w-full rounded-lg border px-3 py-2 text-sm">{t('rooms.loadOlder')}</button>}
      {timeline.map((item, index) => {
        const previous = timeline[index - 1]
        const showDate = !previous || chatDayKey(item.date) !== chatDayKey(previous.date)
        return <Fragment key={`${item.kind}-${item.value.id}`}>
          {showDate && <div className="my-4 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wide text-muted"><span className="h-px flex-1 bg-subtle" /><span>{formatChatDay(item.date, locale)}</span><span className="h-px flex-1 bg-subtle" /></div>}
          {item.kind === 'message'
            ? <MessageCard message={item.value} currentUserID={user?.id} canModerate={canModerate} groupedWithPrevious={isGroupedMessage(timeline, index)} resources={resourcesByMessage.get(item.value.id) ?? []} onReply={setReplyTo} onEdit={editMessage} onDelete={removeMessage} onReaction={toggleReaction} onRemoveResource={removeResourceMutation.mutate} onPreviewResource={openResourceByID} onStartDirect={directMutation.mutate} />
            : <StandaloneResourceCard resource={item.value} currentUserID={user?.id} canModerate={canModerate} onPreview={openResourceByID} onRemove={removeResourceMutation.mutate} onStartDirect={directMutation.mutate} />}
        </Fragment>
      })}
    </div>
    {hasNewMessagesBelow && <button type="button" onClick={() => scrollToLatest()} className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg"><ArrowDown size={14} /> {t('rooms.newMessagesBelow')}</button>}
    </div>
    {typingName && <p className="mb-2 text-xs text-muted">{t('rooms.typing', { name: typingName })}</p>}
    {replyTo && <div className="mb-2 flex justify-between rounded-lg bg-zinc-100 px-3 py-2 text-xs dark:bg-[#1a1d27]"><span>{t('rooms.replyingTo', { name: replyTo.sender_name })}</span><button type="button" onClick={() => setReplyTo(undefined)}>{t('action.cancel')}</button></div>}
    {attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{attachments.map(attachment => <span key={`${attachment.resourceType}-${attachment.resourceID}`} className="flex max-w-full items-center gap-2 rounded-lg border border-subtle bg-surface px-2 py-1 text-xs"><span className="truncate">{attachment.name}</span><button type="button" onClick={() => setAttachments(items => items.filter(item => item.resourceID !== attachment.resourceID || item.resourceType !== attachment.resourceType))} aria-label={t('action.close')}><Trash2 size={14} /></button></span>)}</div>}
    <form className={`z-10 shrink-0 flex items-end gap-1 rounded-2xl border border-zinc-200 bg-white p-1.5 dark:border-[#2d3148] dark:bg-[#0f1117] ${fillAvailableHeight ? 'sticky bottom-0 pb-[max(0.375rem,env(safe-area-inset-bottom))]' : ''}`} onSubmit={event => { event.preventDefault(); if (body.trim() || attachments.length > 0) send.mutate() }}>
      <RoomResourcesPanel room={room} onQueued={attachment => setAttachments(items => [...items.filter(item => item.resourceID !== attachment.resourceID || item.resourceType !== attachment.resourceType), attachment])} />
      <textarea value={body} onChange={event => { setBody(event.target.value); notifyTyping() }} maxLength={10000} rows={2} placeholder={t('rooms.messagePlaceholder')} className="min-h-11 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none" />
      <EmojiPicker userKey={user?.id ?? 'anonymous'} onSelect={emoji => setBody(value => value + emoji)} />
      <GifPicker onSelect={(fileID, name) => sendGIF.mutate({ fileID, name })} />
      <button type="submit" disabled={(!body.trim() && attachments.length === 0) || send.isPending} className="rounded-full bg-brand-600 p-2.5 text-white disabled:opacity-50" aria-label={t('rooms.sendMessage')}><Send size={18} /></button>
    </form>
    {previewID && preview.data && <PreviewModal item={preview.data} onClose={() => setPreviewID(undefined)} />}
    {ooItem && systemSettings.data?.onlyoffice_url && <OnlyOfficeEditor item={ooItem} onlyofficeUrl={systemSettings.data.onlyoffice_url} onClose={() => setOoItem(undefined)} backLabel={t('rooms.backToChat' as never)} />}
  </section>
}
