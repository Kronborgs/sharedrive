import { api } from '@/lib/api'

export type RoomRole = 'owner' | 'moderator' | 'member'

export interface Room {
  id: string
  name: string
  slug: string
  owner_id: string
  created_by?: string
  created_at: string
  updated_at: string
  archived_at?: string
  current_role: RoomRole
}

export interface RoomMember {
  room_id: string
  user_id: string
  role: RoomRole
  display_name: string
  email: string
  joined_at: string
  added_by?: string
}

export function listRooms(signal?: AbortSignal): Promise<Room[]> {
  return api.get<Room[]>('/api/v1/rooms', signal)
}

export function getRoom(roomID: string, signal?: AbortSignal): Promise<Room> {
  return api.get<Room>(`/api/v1/rooms/${roomID}`, signal)
}

export function createRoom(name: string): Promise<Room> {
  return api.post<Room>('/api/v1/rooms', { name })
}

export function updateRoom(roomID: string, name: string): Promise<Room> {
  return api.patch<Room>(`/api/v1/rooms/${roomID}`, { name })
}

export function archiveRoom(roomID: string): Promise<Room> {
  return api.post<Room>(`/api/v1/rooms/${roomID}/archive`, {})
}

export function listRoomMembers(roomID: string, signal?: AbortSignal): Promise<RoomMember[]> {
  return api.get<RoomMember[]>(`/api/v1/rooms/${roomID}/members`, signal)
}

export function addRoomMember(roomID: string, email: string, role: Exclude<RoomRole, 'owner'>): Promise<void> {
  return api.post(`/api/v1/rooms/${roomID}/members`, { email, role })
}

export function removeRoomMember(roomID: string, userID: string): Promise<void> {
  return api.delete(`/api/v1/rooms/${roomID}/members/${userID}`)
}
