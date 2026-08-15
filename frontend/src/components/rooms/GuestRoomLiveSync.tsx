import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

export function GuestRoomLiveSync({ roomID }: Readonly<{ roomID: string }>) {
  const queryClient = useQueryClient()
  useEffect(() => {
    let stopped = false
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${scheme}//${window.location.host}/api/v1/guest/rooms/${roomID}/messages/ws`)
      socket.onmessage = event => {
        const update = JSON.parse(event.data) as { type?: string }
        if (update.type === 'messages_changed') {
          queryClient.invalidateQueries({ queryKey: ['guest-room', roomID, 'messages'] }).catch(() => undefined)
        }
      }
      socket.onclose = () => {
        if (!stopped) retry = setTimeout(connect, 1500)
      }
    }
    connect()
    return () => {
      stopped = true
      if (retry) clearTimeout(retry)
      socket?.close()
    }
  }, [queryClient, roomID])
  return null
}
