import { createFileRoute } from '@tanstack/react-router'
import { GuestNotePage } from '@/components/notes/GuestNotePage'

export const Route = createFileRoute('/notes/guest/$id')({ component: GuestNoteRoute })

function GuestNoteRoute() {
  const { id } = Route.useParams()
  return <GuestNotePage id={id} />
}
