import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { listNotes, type Note } from '@/lib/notes'
import { addRoomResource, type Room, type RoomResourceType } from '@/lib/rooms'
import type { FileItem } from '@/types/api'

function ResourceOptions({ type, files, notes }: Readonly<{ type: RoomResourceType; files: FileItem[]; notes: Note[] }>) {
  if (type === 'file') {
    return <>{files.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</>
  }
  return <>{notes.map(note => <option key={note.id} value={note.id}>{note.title || 'Note uden titel'}</option>)}</>
}

export function RoomResourcesPanel({ room }: Readonly<{ room: Room }>) {
  const queryClient = useQueryClient()
  const [resourceType, setResourceType] = useState<RoomResourceType>('file')
  const [resourceID, setResourceID] = useState('')
  const [fileSearch, setFileSearch] = useState('')
  const fileURL = fileSearch.trim() ? `/api/v1/files/search?q=${encodeURIComponent(fileSearch.trim())}` : '/api/v1/files'
  const files = useQuery({ queryKey: ['rooms', room.id, 'available-files', fileSearch], queryFn: ({ signal }) => api.get<FileItem[]>(fileURL, signal) })
  const notes = useQuery({ queryKey: ['rooms', room.id, 'available-notes'], queryFn: ({ signal }) => listNotes(new URLSearchParams(), signal) })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['rooms', room.id, 'resources'] }).catch(() => undefined)
  const add = useMutation({
    mutationFn: ({ type, id }: { type: RoomResourceType; id: string }) => addRoomResource(room.id, type, id),
    onSuccess: resource => {
      setResourceID('')
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

  return <details className="mt-3 rounded-lg border border-zinc-200 p-3 dark:border-[#2d3148]">
    <summary className="cursor-pointer text-sm font-medium">Tilføj fil eller Note i chatten</summary>
    <form className="mt-3 flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); if (resourceID) add.mutate({ type: resourceType, id: resourceID }) }}>
      <select value={resourceType} onChange={event => selectType(event.target.value as RoomResourceType)} aria-label="Ressourcetype" className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-[#2d3148] dark:bg-[#0f1117]"><option value="file">Fil</option><option value="note">Note</option></select>
      {resourceType === 'file' && <input type="search" value={fileSearch} onChange={event => setFileSearch(event.target.value)} placeholder="Søg i dine filer…" aria-label="Søg efter fil" className="min-w-48 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-[#2d3148] dark:bg-[#0f1117]" />}
      <select value={resourceID} onChange={event => setResourceID(event.target.value)} aria-label="Vælg eksisterende ressource" className="min-w-56 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-[#2d3148] dark:bg-[#0f1117]">
        <option value="">Vælg eksisterende {resourceType === 'file' ? 'fil' : 'Note'}…</option>
        <ResourceOptions type={resourceType} files={fileOptions} notes={noteOptions} />
      </select>
      <button type="submit" disabled={!resourceID || add.isPending} className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm text-white disabled:opacity-50"><Link2 size={16} /> Del i chat</button>
      <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-[#2d3148]">
        <Upload size={16} /><span>{upload.isPending ? 'Uploader…' : 'Upload fil'}</span>
        <input type="file" className="sr-only" disabled={upload.isPending} onChange={selectUpload} />
      </label>
    </form>
  </details>
}