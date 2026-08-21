import { createFileRoute } from '@tanstack/react-router'
import { DirectConversationPage } from '@/components/rooms/DirectConversationPage'
import { RoomConversationSidebar } from '@/components/rooms/RoomConversationSidebar'

function DirectConversationRoute() {
  const { conversationID } = Route.useParams()
  return <section className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-[112rem] flex-col overflow-hidden animate-fade-in lg:h-full">
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:grid lg:h-full lg:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)] lg:overflow-hidden">
      <RoomConversationSidebar activeRoomID={conversationID} mobile />
      <RoomConversationSidebar activeRoomID={conversationID} />
      <DirectConversationPage conversationID={conversationID} />
    </div>
  </section>
}

export const Route = createFileRoute('/_auth/rooms/direct/$conversationID')({ component: DirectConversationRoute })
