import { createFileRoute } from '@tanstack/react-router'
import { DirectConversationPage } from '@/components/rooms/DirectConversationPage'
import { RoomConversationSidebar } from '@/components/rooms/RoomConversationSidebar'

function DirectConversationRoute() {
  const { conversationID } = Route.useParams()
  return <section className="mx-auto flex w-full max-w-[112rem] flex-col animate-fade-in lg:h-full lg:overflow-hidden">
    <div className="grid min-h-0 gap-4 lg:h-full lg:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)] lg:overflow-hidden">
      <RoomConversationSidebar activeRoomID={conversationID} mobile />
      <RoomConversationSidebar activeRoomID={conversationID} />
      <DirectConversationPage conversationID={conversationID} />
    </div>
  </section>
}

export const Route = createFileRoute('/_auth/rooms/direct/$conversationID')({ component: DirectConversationRoute })
