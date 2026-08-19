import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Paperclip, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { FloatingPanel } from '@/components/rooms/FloatingPanel'
import { api } from '@/lib/api'
import { listNotes, type Note } from '@/lib/notes'
import { useI18n } from '@/lib/i18n'
import { type Room, type RoomResourceType } from '@/lib/rooms'
import type { FileItem } from '@/types/api'

function ResourceOptions({ type, files, notes }: Readonly<{ type: RoomResourceType; files: FileItem[]; notes: Note[] }>) {
  const { t } = useI18n()
  if (type === 'file') return <>{files.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</>
  return <>{notes.map(note => <option key={note.id} value={note.id}>{note.title || t('rooms.untitledNote')}</option>)}</>
}

export interface PendingRoomResource {
  resourceType: RoomResourceType
  resourceID: string
  name: string
  mimeType?: string
}

export function RoomResourcesPanel({ room, onQueued }: Readonly<{ room: Room; onQueued: (resource: PendingRoomResource) => void }>) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [resourceType, setResourceType] = useState<RoomResourceType>('file')
  const [resourceID, setResourceID] = useState('')
  const [fileSearch, setFileSearch] = useState('')
  const fileURL = fileSearch.trim() ? `/api/v1/files/search?q=${encodeURIComponent(fileSearch.trim())}` : '/api/v1/files'
  const files = useQuery({ queryKey: ['rooms', room.id, 'available-files', fileSearch], queryFn: ({ signal }) => api.get<FileItem[]>(fileURL, signal), enabled: open })
  const notes = useQuery({ queryKey: ['rooms', room.id, 'available-notes'], queryFn: ({ signal }) => listNotes(new URLSearchParams(), signal), enabled: open })
  const upload = useMutation({
    mutationFn: async (file: globalThis.File) => {
      const formData = new FormData()
      formData.append('file', file)
      const created = await api.post<FileItem>('/api/v1/files/upload', formData)
      return created
    },
    onSuccess: created => {
      setOpen(false)
      queryClient.invalidateQueries({ queryKey: ['files'] }).catch(() => undefined)
      onQueued({ resourceType: 'file', resourceID: created.id, name: created.name, mimeType: created.mime_type ?? undefined })
    },
    onError: () => toast.error(t('rooms.fileUploadFailed')),
  })
  const fileOptions = (files.data ?? []).filter(item => !item.is_folder)
  const noteOptions = (notes.data ?? []).filter(note => !note.deleted_at)
  const selectType = (nextType: RoomResourceType) => {
    setResourceType(nextType)
    setResourceID('')
  }
  const queueExistingResource = () => {
    if (!resourceID) return
    if (resourceType === 'file') {
      const file = fileOptions.find(item => item.id === resourceID)
      if (!file) return
      onQueued({ resourceType, resourceID, name: file.name, mimeType: file.mime_type ?? undefined })
    } else {
      const note = noteOptions.find(item => item.id === resourceID)
      if (!note) return
      onQueued({ resourceType, resourceID, name: note.title || t('rooms.untitledNote') })
    }
    setResourceID('')
    setOpen(false)
  }
  const selectUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0]
    if (selected) upload.mutate(selected)
    event.currentTarget.value = ''
  }

  return <span className="inline-flex">
    <button ref={buttonRef} type="button" onClick={() => setOpen(value => !value)} className="rounded-full p-2 text-muted hover:bg-zinc-100 dark:hover:bg-[#2d3148]" aria-label={t('rooms.addAttachment')} title={t('rooms.addAttachment')} aria-expanded={open}><Paperclip size={19} /></button>
    <input ref={inputRef} type="file" className="sr-only" disabled={upload.isPending} onChange={selectUpload} />
    <FloatingPanel anchorRef={buttonRef} open={open} onOpenChange={setOpen} ariaLabel={t('rooms.addAttachment')} className="w-[min(25rem,calc(100vw-1rem))] p-4">
      <div className="mb-4 flex items-center justify-between"><h3 className="font-semibold">{t('rooms.addToChat')}</h3><button type="button" onClick={() => setOpen(false)} className="rounded-full p-1 text-muted hover:bg-zinc-100 dark:hover:bg-[#2d3148]" aria-label={t('action.close')}><X size={17} /></button></div>
      <button type="button" onClick={() => inputRef.current?.click()} disabled={upload.isPending} className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"><Upload size={18} /><span>{upload.isPending ? t('rooms.uploading') : t('rooms.uploadImageFile')}</span></button>
      <div className="my-4 flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-zinc-200 dark:bg-[#34394f]" /><span>{t('rooms.orShareExisting')}</span><span className="h-px flex-1 bg-zinc-200 dark:bg-[#34394f]" /></div>
      <div className="space-y-3">
        <select value={resourceType} onChange={event => selectType(event.target.value as RoomResourceType)} aria-label={t('rooms.resourceType')} className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-[#34394f] dark:bg-[#11141e] dark:text-slate-100"><option value="file">{t('rooms.file')}</option><option value="note">{t('rooms.note')}</option></select>
        {resourceType === 'file' && <input type="search" value={fileSearch} onChange={event => setFileSearch(event.target.value)} placeholder={t('rooms.searchFiles')} aria-label={t('rooms.searchFileAria')} className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-[#34394f] dark:bg-[#11141e] dark:text-slate-100" />}
        <select value={resourceID} onChange={event => setResourceID(event.target.value)} aria-label={t('rooms.selectResource')} className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-[#34394f] dark:bg-[#11141e] dark:text-slate-100"><option value="">{t(resourceType === 'file' ? 'rooms.chooseFile' : 'rooms.chooseNote')}</option><ResourceOptions type={resourceType} files={fileOptions} notes={noteOptions} /></select>
         <button type="button" onClick={queueExistingResource} disabled={!resourceID} className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-[#34394f] dark:hover:bg-[#2d3148]"><Link2 size={16} /> {t('rooms.shareInChat')}</button>
      </div>
    </FloatingPanel>
  </span>
}
