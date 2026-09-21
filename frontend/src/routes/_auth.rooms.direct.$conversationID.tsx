import { createFileRoute } from '@tanstack/react-router'
import { DirectConversationPage } from '@/components/rooms/DirectConversationPage'
import { RoomConversationSidebar } from '@/components/rooms/RoomConversationSidebar'
import { MobileRoomsInstallBanner } from '@/components/rooms/MobileRoomsInstallBanner'

function DirectConversationRoute() {
  const { conversationID } = Route.useParams()
  return <section className="mx-auto flex h-full min-h-0 w-full max-w-[112rem] flex-col overflow-hidden animate-fade-in">
    <div className="lg:hidden"><MobileRoomsInstallBanner /></div>
    <div className="flex min-h-0 flex-1 flex-col lg:grid lg:h-full lg:grid-cols-[minmax(0,1fr)_minmax(17rem,21rem)] lg:overflow-hidden">
      <RoomConversationSidebar activeRoomID={conversationID} />
      <DirectConversationPage conversationID={conversationID} />
    </div>
  </section>
}

export const Route = createFileRoute('/_auth/rooms/direct/$conversationID')({ component: DirectConversationRoute })
