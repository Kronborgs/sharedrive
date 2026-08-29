import * as Dialog from '@radix-ui/react-dialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Paperclip, Pencil, Plus, Send, Trash2, Users, X } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-context'
import { useI18n } from '@/lib/i18n'
import { addDirectFileResource, createDirectMessage, createGroupConversation, listDirectConversationMembers, listDirectConversations, listDirectMessages, listDirectResources, listRoomMembers, markDirectConversationRead, renameDirectConversation, deleteGroupConversation, hideDirectConversation, type DirectConversation, type DirectConversationMember } from '@/lib/rooms'
import { RoomVoicePanel } from '@/components/rooms/RoomVoicePanel'
import { EmojiPicker } from '@/components/rooms/EmojiPicker'
import { PreviewModal } from '@/components/files/PreviewModal'
import { api } from '@/lib/api'
import type { FileItem } from '@/types/api'

function AddContactDialog({ conversation }: Readonly<{ conversation: DirectConversation }>) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const { user } = useAuth()
  const [selected, setSelected] = useState<string[]>([])
  const members = useQuery({ queryKey: ['rooms', conversation.source_room_id, 'members'], queryFn: ({ signal }) => listRoomMembers(conversation.source_room_id, signal), enabled: open })
  const createGroup = useMutation({
    mutationFn: async () => {
      const names = members.data?.filter(member => selected.includes(member.user_id)).map(member => member.display_name || member.email) ?? []
      return createGroupConversation(conversation.source_room_id, [conversation.other_display_name, ...names].filter(Boolean).join(', '), [conversation.other_user_id, ...selected])
    },
    onSuccess: group => {
      setOpen(false)
      toast.success(t('rooms.groupConversationCreated'))
      navigate({ to: '/rooms/direct/$conversationID', params: { conversationID: group.id } })
    },
    onError: () => toast.error(t('rooms.groupConversationFailed')),
  })

  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button type="button" className="notes-icon-button" title={t('rooms.startGroupRoom')} aria-label={t('rooms.startGroupRoom')}><Plus size={18} /></button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-[#2d3148] dark:bg-[#1a1d27]">
        <div className="flex items-start justify-between gap-3"><div><Dialog.Title className="text-lg font-semibold">{t('rooms.startGroupRoom')}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted">{t('rooms.groupRoomDescription')}</Dialog.Description></div><Dialog.Close asChild><button type="button" className="notes-icon-button" aria-label={t('action.close')}><X size={17} /></button></Dialog.Close></div>
        <form className="mt-5 space-y-4" onSubmit={event => { event.preventDefault(); createGroup.mutate() }}>
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-subtle p-2">{members.data?.filter(member => member.user_id !== user?.id && member.user_id !== conversation.other_user_id).map(member => { const label = member.display_name || member.email; return <div key={member.user_id} className="flex items-center gap-3 rounded px-2 py-2 hover:bg-surface"><input id={`conversation-contact-${member.user_id}`} type="checkbox" checked={selected.includes(member.user_id)} onChange={() => setSelected(items => items.includes(member.user_id) ? items.filter(id => id !== member.user_id) : [...items, member.user_id])} /><label htmlFor={`conversation-contact-${member.user_id}`} className="min-w-0 cursor-pointer"><span className="block truncate text-sm font-medium">{label}</span><span className="block truncate text-xs text-muted">{member.email}</span></label></div> })}</div>
          <div className="flex justify-end gap-2"><Dialog.Close asChild><button type="button" className="rounded-md px-3 py-2 text-sm">{t('action.cancel')}</button></Dialog.Close><button type="submit" className="notes-primary-button" disabled={createGroup.isPending || selected.length === 0}>{t('rooms.addPerson')}</button></div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function GroupMembers({ members }: Readonly<{ members: DirectConversationMember[] }>) {
  const { t } = useI18n()
  const list = <ul className="space-y-3">{members.map(member => <li key={member.user_id} className="min-w-0"><span className="block truncate text-sm font-medium">{member.display_name}</span><span className="block truncate text-xs text-muted">{member.email}</span></li>)}</ul>
  return <><aside className="hidden w-56 shrink-0 border-l border-subtle pl-5 lg:block"><h2 className="mb-4 flex items-center gap-2 font-semibold"><Users size={17} /> {t('rooms.members' as never)} ({members.length})</h2>{list}</aside><Dialog.Root><Dialog.Trigger asChild><button type="button" className="notes-secondary-button lg:hidden"><Users size={16} /> {t('rooms.viewMembers')}</button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" /><Dialog.Content className="fixed inset-x-4 top-1/2 z-50 max-h-[80vh] -translate-y-1/2 overflow-y-auto rounded-lg border border-subtle bg-surface p-5"><Dialog.Title className="mb-4 flex items-center gap-2 text-lg font-semibold"><Users size={18} /> {t('rooms.members' as never)} ({members.length})</Dialog.Title>{list}<Dialog.Close asChild><button type="button" className="notes-secondary-button mt-5">{t('action.close')}</button></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root></>
}

export function DirectConversationPage({ conversationID }: Readonly<{ conversationID: string }>) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<FileItem[]>([])
  const [previewFile, setPreviewFile] = useState<FileItem | undefined>()
  const uploadRef = useRef<HTMLInputElement>(null)
  const messageScrollRef = useRef<HTMLElement>(null)
  const wasAtBottom = useRef(true)
  const conversations = useQuery({ queryKey: ['rooms', 'direct-conversations'], queryFn: ({ signal }) => listDirectConversations(signal) })
  const conversation = conversations.data?.find(item => item.id === conversationID)
  const groupMembers = useQuery({ queryKey: ['rooms', 'direct', conversationID, 'members'], queryFn: ({ signal }) => listDirectConversationMembers(conversationID, signal), enabled: conversation?.kind === 'group' })
  const messages = useQuery({ queryKey: ['rooms', 'direct', conversationID, 'messages'], queryFn: ({ signal }) => listDirectMessages(conversationID, undefined, signal), refetchInterval: 5_000 })
  const resources = useQuery({ queryKey: ['rooms', 'direct', conversationID, 'resources'], queryFn: ({ signal }) => listDirectResources(conversationID, signal) })
  const rename = useMutation({ mutationFn: (name: string) => renameDirectConversation(conversationID, name), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rooms', 'direct-conversations'] }) })
  const removeConversation = useMutation({ mutationFn: () => conversation?.kind === 'group' ? deleteGroupConversation(conversationID) : hideDirectConversation(conversationID), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['rooms', 'direct-conversations'] }).catch(() => undefined); navigate({ to: '/rooms' }).catch(() => undefined) }, onError: () => toast.error(t('rooms.deleteChatFailed' as never)) })
  const send = useMutation({
    mutationFn: async () => {
      const message = await createDirectMessage(conversationID, body)
      await Promise.all(attachments.map(file => addDirectFileResource(conversationID, file.id, message.id)))
      return message
    },
    onSuccess: () => {
      setBody('')
      setAttachments([])
      queryClient.invalidateQueries({ queryKey: ['rooms', 'direct', conversationID, 'messages'] }).catch(() => undefined)
      queryClient.invalidateQueries({ queryKey: ['rooms', 'direct', conversationID, 'resources'] }).catch(() => undefined)
      queryClient.invalidateQueries({ queryKey: ['rooms', 'direct-conversations'] }).catch(() => undefined)
    },
  })

  const upload = useMutation({
    mutationFn: (file: File) => { const data = new FormData(); data.append('file', file); return api.post<FileItem>('/api/v1/files/upload', data) },
    onSuccess: file => {
      setAttachments(items => [...items.filter(item => item.id !== file.id), file])
      toast.success(t('rooms.fileReadyToSend' as never, { name: file.name }))
    },
    onError: () => toast.error(t('rooms.fileUploadFailed')),
  })

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = messageScrollRef.current
    if (container) container.scrollTo({ top: container.scrollHeight, behavior })
  }, [])
  const handleMessageScroll = useCallback(() => {
    const container = messageScrollRef.current
    if (!container) return
    wasAtBottom.current = container.scrollHeight - container.scrollTop - container.clientHeight <= 48
  }, [])
  useEffect(() => {
    const settleAtLatest = () => scrollToLatest('auto')
    const frame = requestAnimationFrame(() => requestAnimationFrame(settleAtLatest))
    const timer = window.setTimeout(settleAtLatest, 150)
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer) }
  }, [conversationID, messages.data?.messages.length, scrollToLatest])
  useEffect(() => {
    const container = messageScrollRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { if (wasAtBottom.current) requestAnimationFrame(() => scrollToLatest('auto')) })
    observer.observe(container)
    return () => observer.disconnect()
  }, [scrollToLatest])
  useEffect(() => { if (messages.data) markDirectConversationRead(conversationID).then(() => queryClient.invalidateQueries({ queryKey: ['rooms', 'direct-conversations'] })).catch(() => undefined) }, [conversationID, messages.data, queryClient])
  if (!conversation) return <p className="p-6 text-sm text-muted">{t('rooms.directUnavailable')}</p>
  const returnToRoom = () => navigate({ to: '/rooms' })
  const conversationTitle = conversation.name || conversation.other_display_name || conversation.other_email

  return <main className="flex min-h-0 flex-1 flex-col lg:order-1 lg:pr-4">
    <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-subtle bg-surface px-4 py-3"><button type="button" className="notes-icon-button" title={conversation.source_room_name ? t('rooms.backToRoom', { room: conversation.source_room_name }) : t('rooms.backToChat' as never)} onClick={returnToRoom}><ArrowLeft size={18} /></button><div className="min-w-0 flex-1"><div className="flex items-center gap-1"><h1 className="truncate font-semibold">{conversationTitle}</h1><button type="button" className="notes-icon-button shrink-0" title={t('rooms.renameConversation')} aria-label={t('rooms.renameConversation')} onClick={() => { const name = window.prompt(t('rooms.conversationName'), conversationTitle); if (name?.trim() && name.trim() !== conversationTitle) rename.mutate(name.trim()) }}><Pencil size={15} /></button></div><p className="text-xs text-muted">{conversation.kind === 'group' ? t('rooms.permanentWorkspace') : t('rooms.directConversation')}</p></div><RoomVoicePanel roomID={conversationID} mediaTokenPath={`/api/v1/rooms/direct-conversations/${conversationID}/media-token`} compact /><AddContactDialog conversation={conversation} />{(conversation.kind !== 'group' || conversation.owner_user_id === user?.id) && <button type="button" className="notes-icon-button text-red-600" title={conversation.kind === 'group' ? t('rooms.deleteGroupChat' as never) : t('rooms.removeDirectChat' as never)} aria-label={conversation.kind === 'group' ? t('rooms.deleteGroupChat' as never) : t('rooms.removeDirectChat' as never)} disabled={removeConversation.isPending} onClick={() => { const confirmation = conversation.kind === 'group' ? t('rooms.deleteGroupChatConfirm' as never, { name: conversationTitle }) : t('rooms.removeDirectChatConfirm' as never, { name: conversationTitle }); if (window.confirm(confirmation)) removeConversation.mutate() }}><Trash2 size={17} /></button>}</header>
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <section ref={messageScrollRef} onScroll={handleMessageScroll} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">{[...(messages.data?.messages ?? [])].reverse().map(message => { const own = message.sender_user_id === user?.id; const messageResources = (resources.data ?? []).filter(resource => resource.message_id === message.id); return <article key={message.id} className={`flex flex-col ${own ? 'items-end' : 'items-start'}`}><div className="mb-1 text-xs text-muted">{message.sender_name}</div><p className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${own ? 'bg-brand-600 text-white' : 'bg-surface'}`}>{message.deleted_at ? t('rooms.messageDeleted') : message.body}</p>{messageResources.map(resource => { const previewItem: FileItem = { id: resource.file_id, parent_id: null, owner_id: '', is_folder: false, name: resource.name, mime_type: resource.mime_type ?? null, size_bytes: 0, checksum_sha256: null, deleted_at: null, created_at: resource.created_at, updated_at: resource.created_at }; const isImage = resource.mime_type?.startsWith('image/') || /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(resource.name); return isImage ? <button key={resource.id} type="button" onClick={() => setPreviewFile(previewItem)} className="mt-1 block max-w-[80%] overflow-hidden rounded-xl border border-subtle bg-zinc-950"><img src={'/api/v1/files/' + resource.file_id + '/thumbnail'} alt={resource.name} className="max-h-64 max-w-full object-contain" loading="lazy" /></button> : <button key={resource.id} type="button" onClick={() => setPreviewFile(previewItem)} className="mt-1 max-w-[80%] rounded-lg border border-subtle bg-surface px-3 py-2 text-left text-sm text-brand-600 hover:underline">{resource.name}</button> })}</article> })}<div /></section>{previewFile && <PreviewModal item={previewFile} onClose={() => setPreviewFile(undefined)} />}
        {attachments.length > 0 && <div className="flex shrink-0 flex-wrap gap-2 px-3 pb-2">{attachments.map(file => <span key={file.id} className="flex items-center gap-1 rounded-full border border-subtle px-2 py-1 text-xs">{file.name}<button type="button" onClick={() => setAttachments(items => items.filter(item => item.id !== file.id))} aria-label={t('action.close')}><X size={13} /></button></span>)}</div>}
        <form className="sticky bottom-0 flex shrink-0 items-end gap-2 border-t border-subtle bg-surface p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" onSubmit={event => { event.preventDefault(); if (body.trim() || attachments.length > 0) send.mutate() }}><button type="button" className="notes-icon-button" onClick={() => uploadRef.current?.click()} disabled={upload.isPending} aria-label={t('rooms.addAttachment')}><Paperclip size={18} /></button><input ref={uploadRef} type="file" className="sr-only" onChange={event => { const file = event.target.files?.[0]; if (file) { upload.mutate(file) }; event.currentTarget.value = '' }} /><input className="notes-input min-w-0 flex-1" value={body} onChange={event => setBody(event.target.value)} placeholder={t('rooms.messagePlaceholder')} /><EmojiPicker userKey={user?.id ?? 'anonymous'} onSelect={emoji => setBody(value => value + emoji)} /><button className="notes-primary-button" type="submit" disabled={(!body.trim() && attachments.length === 0) || send.isPending}><Send size={17} /></button></form>
      </div>
      {conversation.kind === 'group' && <GroupMembers members={groupMembers.data ?? []} />}
    </div>
  </main>
}
