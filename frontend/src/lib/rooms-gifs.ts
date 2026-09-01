import { api } from '@/lib/api'

export interface GIFLibraryItem {
  id: string
  file_id: string
  title: string
  category?: string
  name: string
  mime_type: string
}

const REMOTE_GIF_HOSTS = new Set([
  'media.giphy.com',
  'i.giphy.com',
  'giphy.com',
  'www.giphy.com',
  'media.tenor.com',
  'c.tenor.com',
  'tenor.com',
  'www.tenor.com',
])

export function isRemoteGIFURL(value: string): boolean {
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'https:'
      && REMOTE_GIF_HOSTS.has(parsed.hostname.toLowerCase())
      && parsed.port === ''
      && parsed.pathname.toLowerCase().endsWith('.gif')
  } catch {
    return false
  }
}

export function importRemoteGIF(url: string): Promise<GIFLibraryItem> {
  return api.post<GIFLibraryItem>('/api/v1/rooms/gifs/import', { url: url.trim() })
}
