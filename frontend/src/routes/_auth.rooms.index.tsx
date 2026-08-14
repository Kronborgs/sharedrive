import { createFileRoute } from '@tanstack/react-router'
import { RoomListPage } from '@/components/rooms/RoomListPage'

export const Route = createFileRoute('/_auth/rooms/')({ component: RoomListPage })
