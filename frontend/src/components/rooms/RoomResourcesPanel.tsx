import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Paperclip, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { FloatingPanel } from '@/components/rooms/FloatingPanel'
import { api } from '@/lib/api'
import { listNotes, type Note } from '@/lib/notes'
import { addRoomResource, type Room, type RoomResourceType } from '@/lib/rooms'
import type { FileItem } from '@/types/api'

function ResourceOptions({ type, files, notes }: Readonly<{ type: RoomResourceType; files: FileItem[]; notes: Note[] }>) {
  if (type === 'file') return <>{files.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</>
  return <>{notes.map(note => <option key={note.id} value={note.id}>{note.title || 'Note uden titel'}</option>)}</>
}

export function RoomResourcesPanel({ room }: Readonly<{ room: Room }>) {
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
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['rooms', room.id, 'resources'] }).catch(() => undefined)
  const add = useMutation({
    mutationFn: ({ type, id }: { type: RoomResourceType; id: string }) => addRoomResource(room.id, type, id),
    onSuccess: resource => {
      setResourceID('')
      setOpen(false)
      refresh()
      toast.success(`${resource.name || 'Ressourcen'} er delt i chatten.`)
    },
    onError: () => toast.error('Ressourcen kunne ikke deles i chatten.'),
  })
  const upload = useMutation({
    mutationFn: async (file: globalThis.File) => {
      const formData = new FormData()
      formData.append('file', file)
      const created = await api.post<FileItem>('/api/v1/files/upload', formData)
      return addRoomResource(room.id, 'file', created.id)
    },
    onSuccess: resource => {
      setOpen(false)
      refresh()
      queryClient.invalidateQueries({ queryKey: ['files'] }).catch(() => undefined)
      toast.success(`${resource.name || 'Filen'} er uploadet og vist i chatten.`)
    },
    onError: () => toast.error('Filen kunne ikke uploades og deles i chatten.'),
  })
  const fileOptions = (files.data ?? []).filter(item => !item.is_folder)
  const noteOptions = (notes.data ?? []).filter(note => !note.deleted_at)
  const selectType = (nextType: RoomResourceType) => {
    setResourceType(nextType)
    setResourceID('')
  }
  const selectUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0]
    if (selected) upload.mutate(selected)
    event.currentTarget.value = ''
  }

  return <span className="inline-flex">
    <button ref={buttonRef} type="button" onClick={() => setOpen(value => !value)} className="rounded-full p-2 text-muted hover:bg-zinc-100 dark:hover:bg-[#2d3148]" aria-label="Tilføj billede, fil eller Note" title="Tilføj billede, fil eller Note" aria-expanded={open}><Paperclip size={19} /></button>
    <input ref={inputRef} type="file" className="sr-only" disabled={upload.isPending} onChange={selectUpload} />
    <FloatingPanel anchorRef={buttonRef} open={open} onOpenChange={setOpen} ariaLabel="Tilføj billede, fil eller Note" className="w-[min(25rem,calc(100vw-1rem))] p-4">
      <div className="mb-4 flex items-center justify-between"><h3 className="font-semibold">Tilføj til chatten</h3><button type="button" onClick={() => setOpen(false)} className="rounded-full p-1 text-muted hover:bg-zinc-100 dark:hover:bg-[#2d3148]" aria-label="Luk"><X size={17} /></button></div>
      <button type="button" onClick={() => inputRef.current?.click()} disabled={upload.isPending} className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"><Upload size={18} /><span>{upload.isPending ? 'Uploader…' : 'Upload billede eller fil'}</span></button>
      <div className="my-4 flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-zinc-200 dark:bg-[#34394f]" /><span>eller del en eksisterende</span><span className="h-px flex-1 bg-zinc-200 dark:bg-[#34394f]" /></div>
      <div className="space-y-3">
        <select value={resourceType} onChange={event => selectType(event.target.value as RoomResourceType)} aria-label="Ressourcetype" className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-[#34394f] dark:bg-[#11141e]"><option value="file">Fil</option><option value="note">Note</option></select>
        {resourceType === 'file' && <input type="search" value={fileSearch} onChange={event => setFileSearch(event.target.value)} placeholder="Søg i dine filer…" aria-label="Søg efter fil" className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-[#34394f] dark:bg-[#11141e]" />}
        <select value={resourceID} onChange={event => setResourceID(event.target.value)} aria-label="Vælg eksisterende ressource" className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-[#34394f] dark:bg-[#11141e]"><option value="">Vælg {resourceType === 'file' ? 'fil' : 'Note'}…</option><ResourceOptions type={resourceType} files={fileOptions} notes={noteOptions} /></select>
        <button type="button" onClick={() => resourceID && add.mutate({ type: resourceType, id: resourceID })} disabled={!resourceID || add.isPending} className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-[#34394f] dark:hover:bg-[#2d3148]"><Link2 size={16} /> Del i chatten</button>
      </div>
    </FloatingPanel>
  </span>
}