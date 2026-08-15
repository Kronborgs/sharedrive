import { useState } from 'react'
import { Upload } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import type { RoomResource } from '@/lib/rooms'
import { guestTusThresholdBytes, uploadGuestRoomTus } from '@/lib/guest-room-upload'

export function GuestRoomUpload({ roomID, maxFileBytes }: Readonly<{ roomID: string; maxFileBytes: number }>) {
  const [file, setFile] = useState<File>()
  const [pending, setPending] = useState(false)
  const [progress, setProgress] = useState(0)
  const upload = async () => {
    if (!file) return
    if (file.size > maxFileBytes) {
      toast.error('Filen må højst være ' + Math.round(maxFileBytes / (1024 * 1024)) + ' MB.')
      return
    }
    const form = new FormData()
    form.append('file', file)
    setPending(true)
    try {
      let uploadedName = file.name
      if (file.size >= guestTusThresholdBytes) {
        await uploadGuestRoomTus(roomID, file, setProgress)
      } else {
        const resource = await api.post<RoomResource>(`/api/v1/guest/rooms/${roomID}/uploads`, form)
        uploadedName = resource.name || file.name
      }
      toast.success(`${uploadedName} er uploadet til Room-ejerens filer.`)
      setFile(undefined)
    } catch {
      toast.error('Filen kunne ikke uploades. Kontrollér størrelse, kvote og gæsteregler.')
    } finally {
      setPending(false)
      setProgress(0)
    }
  }
  return <section className="mt-6 border-t border-zinc-200 pt-5 dark:border-[#2d3148]" aria-labelledby="guest-upload-heading">
    <h2 id="guest-upload-heading" className="text-lg font-semibold">Upload fil</h2>
    <p className="mt-1 text-sm text-muted">Maks. {Math.round(maxFileBytes / (1024 * 1024))} MB pr. fil. Filen gemmes hos Room-ejeren i <code>Rooms/&lt;room&gt;/Guest uploads</code>, tæller på ejerens kvote og bliver ikke slettet, når gæstelinket tilbagekaldes.</p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <input type="file" onChange={event => setFile(event.target.files?.[0])} className="max-w-full text-sm" />
      <button type="button" onClick={() => { upload().catch(() => undefined) }} disabled={!file || pending} className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm text-white disabled:opacity-50"><Upload size={16} /> {pending ? 'Uploader… ' + progress + '%' : 'Upload'}</button>
    </div>
  </section>
}
