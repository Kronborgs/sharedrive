import { NoteEditor } from '@/components/notes/NoteEditor'

export function GuestNotePage({ id }: Readonly<{ id: string }>) {
  return (
    <main className="min-h-screen bg-[#f7f5ed] px-4 py-8 text-zinc-900 dark:bg-[#0f1117] dark:text-zinc-100">
      <NoteEditor id={id} guest />
    </main>
  )
}
