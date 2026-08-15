import { Upload } from 'tus-js-client'
import { api } from '@/lib/api'

export const guestTusThresholdBytes = 5 * 1024 * 1024

interface GuestUploadTokenResponse {
  token: string
  folder_id: string
  max_file_bytes: number
}

export async function uploadGuestRoomTus(
  roomID: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  const issued = await api.post<GuestUploadTokenResponse>(`/api/v1/guest/rooms/${roomID}/upload-token`, {})
  if (file.size > issued.max_file_bytes) {
    throw new Error('file exceeds the configured guest upload limit')
  }
  await new Promise<void>((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint: '/upload/',
      retryDelays: [0, 1000, 3000, 5000],
      headers: { 'X-Upload-Token': issued.token },
      metadata: {
        filename: file.name,
        filetype: file.type || 'application/octet-stream',
        folder_id: issued.folder_id,
      },
      onProgress: (uploaded, total) => onProgress(total > 0 ? Math.round((uploaded / total) * 100) : 0),
      onError: reject,
      onSuccess: () => resolve(),
    })
    upload.start()
  })
}
