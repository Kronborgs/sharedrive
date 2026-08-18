import { useI18n } from '@/lib/i18n'
import { DoorOpen } from 'lucide-react'
import { RoomConversationSidebar } from '@/components/rooms/RoomConversationSidebar'

export function RoomListPage() {
  const { t } = useI18n()
  return <section className="mx-auto grid w-full max-w-[112rem] animate-fade-in lg:h-full lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-4 lg:overflow-hidden" aria-labelledby="rooms-heading">
    <RoomConversationSidebar mobile />
    <RoomConversationSidebar />
    <main className="flex min-h-[20rem] flex-col items-center justify-center px-6 text-center lg:min-h-0"><DoorOpen className="mb-4 text-brand-600" size={34} /><h1 id="rooms-heading" className="text-xl font-semibold">{t('rooms.title' as never)}</h1><p className="mt-2 text-sm text-muted">{t('rooms.selectConversation' as never)}</p></main>
  </section>
}
