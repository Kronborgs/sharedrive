import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Send, X } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-context'
import { useI18n } from '@/lib/i18n'
import { addRoomMember, createDirectMessage, createRoom, listDirectConversations, listDirectMessages, markDirectConversationRead, type DirectConversation } from '@/lib/rooms'

function GroupRoomDialog({ conversation }: Readonly<{ conversation: DirectConversation }>) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [emails, setEmails] = useState('')
  const createGroup = useMutation({
    mutationFn: async () => {
      const room = await createRoom(name.trim())
      const recipients = [conversation.other_email, ...emails.split(',').map(email => email.trim()).filter(Boolean)]
      await Promise.all(recipients.map(email => addRoomMember(room.id, email, 'member')))
      return room
    },
    onSuccess: room => {
      setOpen(false)
      toast.success(t('rooms.groupRoomCreated'))
      navigate({ to: '/rooms/$roomID', params: { roomID: room.slug } })
    },
    onError: () => toast.error(t('rooms.groupRoomFailed')),
  })

  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button type="button" className="notes-icon-button" title={t('rooms.startGroupRoom')} aria-label={t('rooms.startGroupRoom')}><Plus size={18} /></button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-[#2d3148] dark:bg-[#1a1d27]">
        <div className="flex items-start justify-between gap-3"><div><Dialog.Title className="text-lg font-semibold">{t('rooms.startGroupRoom')}</Dialog.Title><Dialog.Description className="mt-1 text-sm text-muted">{t('rooms.groupRoomDescription')}</Dialog.Description></div><Dialog.Close asChild><button type="button" className="notes-icon-button" aria-label={t('action.close')}><X size={17} /></button></Dialog.Close></div>
        <form className="mt-5 space-y-4" onSubmit={event => { event.preventDefault(); createGroup.mutate() }}>
          <label className="block text-sm font-medium"><span>{t('rooms.roomName')}</span><input required value={name} onChange={event => setName(event.target.value)} className="mt-1.5 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-[#3a3f58] dark:bg-[#11141e]" /></label>
          <label className="block text-sm font-medium"><span>{t('rooms.additionalEmails')}</span><input value={emails} onChange={event => setEmails(event.target.value)} className="mt-1.5 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 dark:border-[#3a3f58] dark:bg-[#11141e]" /><span className="mt-1 block text-xs text-muted">{t('rooms.additionalEmailsHint')}</span></label>
          <div className="flex justify-end gap-2"><Dialog.Close asChild><button type="button" className="rounded-md px-3 py-2 text-sm">{t('action.cancel')}</button></Dialog.Close><button type="submit" className="notes-primary-button" disabled={createGroup.isPending || !name.trim()}>{t('rooms.create')}</button></div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

export function DirectConversationPage({ conversationID }: Readonly<{ conversationID: string }>) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user } = useAuth()
  const [body, setBody] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const conversations = useQuery({ queryKey: ['rooms', 'direct-conversations'], queryFn: ({ signal }) => listDirectConversations(signal) })
  const conversation = conversations.data?.find(item => item.id === conversationID)
  const messages = useQuery({ queryKey: ['rooms', 'direct', conversationID, 'messages'], queryFn: ({ signal }) => listDirectMessages(conversationID, undefined, signal), refetchInterval: 5_000 })
  const send = useMutation({
    mutationFn: () => createDirectMessage(conversationID, body),
    onSuccess: () => {
      setBody('')
      queryClient.invalidateQueries({ queryKey: ['rooms', 'direct', conversationID, 'messages'] }).catch(() => undefined)
      queryClient.invalidateQueries({ queryKey: ['rooms', 'direct-conversations'] }).catch(() => undefined)
    },
  })

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.data?.messages.length])
  useEffect(() => { if (messages.data) markDirectConversationRead(conversationID).then(() => queryClient.invalidateQueries({ queryKey: ['rooms', 'direct-conversations'] })).catch(() => undefined) }, [conversationID, messages.data, queryClient])
  if (!conversation) return <p className="p-6 text-sm text-muted">{t('rooms.directUnavailable')}</p>
  const returnToRoom = () => navigate({ to: '/rooms/$roomID', params: { roomID: conversation.source_room_slug } })

  return <main className="flex min-h-0 flex-1 flex-col">
    <header className="flex items-center gap-3 border-b border-subtle px-4 py-3"><button type="button" className="notes-icon-button" title={t('rooms.backToRoom', { room: conversation.source_room_name })} onClick={returnToRoom}><ArrowLeft size={18} /></button><div className="min-w-0 flex-1"><h1 className="truncate font-semibold">{conversation.other_display_name || conversation.other_email}</h1><p className="text-xs text-muted">{t('rooms.directFromRoom', { room: conversation.source_room_name })}</p></div><GroupRoomDialog conversation={conversation} /></header>
    <section className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">{[...(messages.data?.messages ?? [])].reverse().map(message => { const own = message.sender_user_id === user?.id; return <article key={message.id} className={`flex flex-col ${own ? 'items-end' : 'items-start'}`}><div className="mb-1 text-xs text-muted">{message.sender_name}</div><p className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${own ? 'bg-brand-600 text-white' : 'bg-surface'}`}>{message.deleted_at ? t('rooms.messageDeleted') : message.body}</p></article> })}<div ref={bottomRef} /></section>
    <form className="flex shrink-0 gap-2 border-t border-subtle p-3" onSubmit={event => { event.preventDefault(); if (body.trim()) send.mutate() }}><input className="notes-input min-w-0 flex-1" value={body} onChange={event => setBody(event.target.value)} placeholder={t('rooms.messagePlaceholder')} /><button className="notes-primary-button" type="submit" disabled={!body.trim() || send.isPending}><Send size={17} /></button></form>
  </main>
}
