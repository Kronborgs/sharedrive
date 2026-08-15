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
export interface RoomMessage {
  id: string
  room_id: string
  sender_user_id?: string
  sender_guest_session_id?: string
  sender_name: string
  body: string
  reply_to_message_id?: string
  created_at: string
  edited_at?: string
  deleted_at?: string
  reactions: Array<{ user_id?: string; guest_session_id?: string; emoji: string }>
}

export interface RoomMessagePage {
  messages: RoomMessage[]
  next_cursor?: string
}

export function listRoomMessages(roomID: string, cursor?: string, signal?: AbortSignal): Promise<RoomMessagePage> {
  const query = new URLSearchParams({ limit: '50' })
  if (cursor) query.set('cursor', cursor)
  return api.get<RoomMessagePage>(`/api/v1/rooms/${roomID}/messages?${query}`, signal)
}

export function createRoomMessage(roomID: string, body: string, replyTo?: string): Promise<RoomMessage> {
  return api.post<RoomMessage>(`/api/v1/rooms/${roomID}/messages`, { body, reply_to_message_id: replyTo })
}
export type RoomResourceType = 'file' | 'note'
export interface RoomResource {
  id: string
  room_id: string
  resource_type: RoomResourceType
  resource_id: string
  added_by?: string
  created_at: string
  accessible: boolean
  name?: string
  mime_type?: string
  is_folder?: boolean
  note_type?: string
}
export function listRoomResources(roomID: string, signal?: AbortSignal): Promise<RoomResource[]> {
  return api.get<RoomResource[]>(`/api/v1/rooms/${roomID}/resources`, signal)
}
export function addRoomResource(roomID: string, resourceType: RoomResourceType, resourceID: string): Promise<RoomResource> {
  return api.post<RoomResource>(`/api/v1/rooms/${roomID}/resources`, { resource_type: resourceType, resource_id: resourceID })
}
export function removeRoomResource(roomID: string, linkID: string): Promise<void> {
  return api.delete(`/api/v1/rooms/${roomID}/resources/${linkID}`)
}
export function updateRoomMessage(roomID: string, messageID: string, body: string): Promise<RoomMessage> {
  return api.patch<RoomMessage>(`/api/v1/rooms/${roomID}/messages/${messageID}`, { body })
}
export function deleteRoomMessage(roomID: string, messageID: string): Promise<void> {
  return api.delete(`/api/v1/rooms/${roomID}/messages/${messageID}`)
}
export function addRoomReaction(roomID: string, messageID: string, emoji: string): Promise<void> {
  return api.post(`/api/v1/rooms/${roomID}/messages/${messageID}/reactions`, { emoji })
}
export function removeRoomReaction(roomID: string, messageID: string, emoji: string): Promise<void> {
  return api.delete(`/api/v1/rooms/${roomID}/messages/${messageID}/reactions?emoji=${encodeURIComponent(emoji)}`)
}
export function markRoomRead(roomID: string, messageID: string): Promise<void> {
  return api.put(`/api/v1/rooms/${roomID}/read-state`, { message_id: messageID })
}
export interface RoomInvite {
  id: string
  room_id: string
  label: string
  can_chat: boolean
  can_upload: boolean
  can_voice: boolean
  can_share_screen: boolean
  expires_at: string
  revoked_at?: string
  created_at: string
}

export interface CreateRoomInviteInput {
  label: string
  expires_hours: number
  can_chat: boolean
  can_upload: boolean
  can_voice: boolean
  can_share_screen: boolean
}

export interface GuestRoom {
  id: string
  name: string
  guest_session_id: string
  display_name: string
  can_chat: boolean
  can_upload: boolean
  upload_max_file_bytes: number
  upload_max_files_session: number
  can_voice: boolean
  can_share_screen: boolean
  expires_at: string
}

export function listRoomInvites(roomID: string, signal?: AbortSignal): Promise<RoomInvite[]> {
  return api.get<RoomInvite[]>(`/api/v1/rooms/${roomID}/invites`, signal)
}

export function createRoomInvite(roomID: string, input: CreateRoomInviteInput): Promise<{ invite: RoomInvite; invite_url: string }> {
  return api.post(`/api/v1/rooms/${roomID}/invites`, input)
}

export function revokeRoomInvite(roomID: string, inviteID: string): Promise<void> {
  return api.delete(`/api/v1/rooms/${roomID}/invites/${inviteID}`)
}

export function acceptRoomInvite(token: string, displayName: string): Promise<{ room_id: string; session_id: string }> {
  return api.post(`/api/v1/public/rooms/invitations/${encodeURIComponent(token)}/accept`, { display_name: displayName })
}

export function getGuestRoom(roomID: string, signal?: AbortSignal): Promise<GuestRoom> {
  return api.get<GuestRoom>(`/api/v1/guest/rooms/${roomID}`, signal)
}

export function listGuestRoomMessages(roomID: string, signal?: AbortSignal): Promise<RoomMessagePage> {
  return api.get<RoomMessagePage>(`/api/v1/guest/rooms/${roomID}/messages?limit=50`, signal)
}

export function createGuestRoomMessage(roomID: string, body: string): Promise<RoomMessage> {
  return api.post<RoomMessage>(`/api/v1/guest/rooms/${roomID}/messages`, { body })
}

export function logoutGuestRoom(): Promise<void> {
  return api.post('/api/v1/guest/rooms/logout', {})
}