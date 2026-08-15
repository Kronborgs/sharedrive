import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { File, FileText, Link2, Trash2, Upload } from 'lucide-react'
import { api } from '@/lib/api'
import { listNotes } from '@/lib/notes'
import { addRoomResource, listRoomResources, removeRoomResource, type Room, type RoomResourceType } from '@/lib/rooms'
import type { FileItem } from '@/types/api'

export function RoomResourcesPanel({ room }: Readonly<{ room: Room }>) {
  const queryClient = useQueryClient()
  const [resourceType, setResourceType] = useState<RoomResourceType>('file')
  const [resourceID, setResourceID] = useState('')
  const [fileSearch, setFileSearch] = useState('')
  const queryKey = ['rooms', room.id, 'resources']
  const resources = useQuery({ queryKey, queryFn: ({ signal }) => listRoomResources(room.id, signal) })
  const files = useQuery({
    queryKey: ['rooms', room.id, 'available-files', fileSearch],
    queryFn: ({ signal }) => api.get<FileItem[]>(fileSearch.trim() ? `/api/v1/files/search?q=${encodeURIComponent(fileSearch.trim())}` : '/api/v1/files', signal),
  })
  const notes = useQuery({
    queryKey: ['rooms', room.id, 'available-notes'],
    queryFn: ({ signal }) => listNotes(new URLSearchParams(), signal),
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey }).catch(() => undefined)
  const add = useMutation({
    mutationFn: ({ type, id }: { type: RoomResourceType; id: string }) => addRoomResource(room.id, type, id),
    onSuccess: () => { setResourceID(''); refresh() },
  })
  const upload = useMutation({
    mutationFn: async (file: globalThis.File) => {
      const formData = new FormData()
      formData.append('file', file)
      const created = await api.post<FileItem>('/api/v1/files/upload', formData)
      return addRoomResource(room.id, 'file', created.id)
    },
    onSuccess: () => {
      refresh()
      queryClient.invalidateQueries({ queryKey: ['files'] }).catch(() => undefined)
      queryClient.invalidateQueries({ queryKey: ['rooms', room.id, 'available-files'] }).catch(() => undefined)
    },
  })
  const remove = useMutation({
    mutationFn: (linkID: string) => removeRoomResource(room.id, linkID),
    onSuccess: refresh,
  })
  const canManage = room.current_role === 'owner' || room.current_role === 'moderator'
  const fileOptions = (files.data ?? []).filter(item => !item.is_folder)
  const noteOptions = (notes.data ?? []).filter(note => !note.deleted_at)

  return (
    <section className="mt-6 border-t border-zinc-200 pt-6 dark:border-[#2d3148]" aria-labelledby="room-resources-heading">
      <h2 id="room-resources-heading" className="mb-3 text-lg font-semibold text-zinc-950 dark:text-white">Filer og Noter</h2>
      <div className="space-y-2">
        {resources.data?.map(resource => (
          <article key={resource.id} className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-[#2d3148]">
            {resource.resource_type === 'file' ? <File size={18} /> : <FileText size={18} />}
            <div className="min-w-0 flex-1">
              {resource.accessible ? (
                <a href={resource.resource_type === 'file' ? `/files?preview=${resource.resource_id}` : `/notes/${resource.resource_id}`} className="truncate text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
                  {resource.name}
                </a>
              ) : <p className="truncate text-sm font-medium">Adgang kræves</p>}
              <p className="text-xs text-muted">{resource.resource_type === 'file' ? 'Sharedrive-fil' : 'Sharedrive-Note'}</p>
            </div>
            {canManage && <button type="button" aria-label="Fjern reference" onClick={() => remove.mutate(resource.id)} className="text-red-600"><Trash2 size={16} /></button>}
          </article>
        ))}
        {resources.data?.length === 0 && <p className="text-sm text-muted">Ingen filer eller Noter er knyttet til rummet.</p>}
      </div>

      <form className="mt-3 flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); if (resourceID) add.mutate({ type: resourceType, id: resourceID }) }}>
        <select value={resourceType} onChange={event => { setResourceType(event.target.value as RoomResourceType); setResourceID('') }} aria-label="Ressourcetype" className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-[#2d3148] dark:bg-[#0f1117]">
          <option value="file">Fil</option><option value="note">Note</option>
        </select>
        {resourceType === 'file' && <input type="search" value={fileSearch} onChange={event => setFileSearch(event.target.value)} placeholder="Søg i alle dine filer…" aria-label="Søg efter fil" className="min-w-52 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-[#2d3148] dark:bg-[#0f1117]" />}
        <select value={resourceID} onChange={event => setResourceID(event.target.value)} aria-label="Vælg eksisterende ressource" className="min-w-64 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-[#2d3148] dark:bg-[#0f1117]">
          <option value="">Vælg eksisterende {resourceType === 'file' ? 'fil' : 'Note'}…</option>
          {resourceType === 'file'
            ? fileOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)
            : noteOptions.map(note => <option key={note.id} value={note.id}>{note.title || 'Note uden titel'}</option>)}
        </select>
        <button type="submit" disabled={!resourceID || add.isPending} className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm text-white disabled:opacity-50"><Link2 size={16} /> Tilknyt</button>
        <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-sm dark:border-[#2d3148]">
          <Upload size={16} /> {upload.isPending ? 'Uploader…' : 'Upload fil'}
          <input type="file" className="sr-only" disabled={upload.isPending} onChange={event => { const selected = event.target.files?.[0]; if (selected) upload.mutate(selected); event.currentTarget.value = '' }} />
        </label>
      </form>
      {(add.isError || upload.isError) && <p className="mt-2 text-xs text-red-600">Ressourcen kunne ikke tilknyttes. Kontrollér adgang og re-share-rettighed.</p>}
      <p className="mt-2 text-xs text-muted">Upload gemmer filen i dit normale Sharedrive-lager og knytter derefter samme fil til rummet.</p>
    </section>
  )
}