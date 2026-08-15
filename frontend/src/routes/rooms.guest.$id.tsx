import { createFileRoute } from '@tanstack/react-router'
import { GuestRoomPage } from '@/components/rooms/GuestRoomPage'

export const Route = createFileRoute('/rooms/guest/$id')({ component: GuestRoomRoute })

function GuestRoomRoute() {
  const { id } = Route.useParams()
  return <GuestRoomPage roomID={id} />
}
