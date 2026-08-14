import { createFileRoute } from '@tanstack/react-router'
import { RoomDetailPage } from '@/components/rooms/RoomDetailPage'

export const Route = createFileRoute('/_auth/rooms/$roomID')({
  component: RoomRoute,
})

function RoomRoute() {
  const { roomID } = Route.useParams()
  return <RoomDetailPage roomID={roomID} />
}
