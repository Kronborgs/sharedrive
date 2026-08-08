import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { NoteEditor } from '@/components/notes/NoteEditor'

export const Route = createFileRoute('/_auth/notes/$id')({
  validateSearch: z.object({ deleted: z.boolean().optional() }),
  component: NoteRoute,
})

function NoteRoute() {
  const { id } = Route.useParams()
  const { deleted } = Route.useSearch()
  return <NoteEditor id={id} includeDeleted={deleted} />
}