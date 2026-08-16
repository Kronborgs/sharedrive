import { useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import type { RoomResource } from '@/lib/rooms'
import { guestTusThresholdBytes, uploadGuestRoomTus } from '@/lib/guest-room-upload'

export function GuestRoomUpload({ roomID, maxFileBytes, onUploaded }: Readonly<{ roomID: string; maxFileBytes: number; onUploaded?: () => void }>) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState(false)
  const upload = async (file: File) => {
    if (file.size > maxFileBytes) { toast.error(`Filen må højst være ${Math.round(maxFileBytes / (1024 * 1024))} MB.`); return }
    const form = new FormData()
    form.append('file', file)
    setPending(true)
    try {
      let uploadedName = file.name
      if (file.size >= guestTusThresholdBytes) await uploadGuestRoomTus(roomID, file, () => undefined)
      else {
        const resource = await api.post<RoomResource>(`/api/v1/guest/rooms/${roomID}/uploads`, form)
        uploadedName = resource.name || file.name
      }
      toast.success(`${uploadedName} er sendt i chatten.`)
      onUploaded?.()
    } catch { toast.error('Filen kunne ikke uploades. Kontrollér størrelse, kvote og gæsteregler.') }
    finally { setPending(false) }
  }
  return <span className="inline-flex">
    <button type="button" disabled={pending} onClick={() => inputRef.current?.click()} className="rounded-full p-2 text-muted hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-[#2d3148]" aria-label="Send billede eller fil" title={`Send billede eller fil (maks. ${Math.round(maxFileBytes / (1024 * 1024))} MB)`}><ImagePlus size={19} /></button>
    <input ref={inputRef} type="file" className="sr-only" onChange={event => { const file = event.target.files?.[0]; if (file) upload(file).catch(() => undefined); event.currentTarget.value = '' }} />
  </span>
}
