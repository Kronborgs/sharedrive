import { api } from '@/lib/api'

export type RoomRole = 'owner' | 'moderator' | 'member'

export interface Room {
  id: string
  name: string
  slug: string
  owner_id: string
	icon_file_id?: string
  created_by?: string
  created_at: string
  updated_at: string
  archived_at?: string
  current_role: RoomRole
  unread_count: number
  voice_active: boolean
}

export interface PublicRoomSettings {
  rooms_enabled?: boolean
  rooms_voice_enabled?: boolean
}

export function getPublicRoomSettings(signal?: AbortSignal): Promise<PublicRoomSettings> {
  return api.get<PublicRoomSettings>('/api/v1/system/settings', signal)
}

export function totalRoomUnread(rooms: Room[]): number {
  return rooms.reduce((total, room) => total + Math.max(0, room.unread_count ?? 0), 0)
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

export function updateRoomIcon(roomID: string, iconFileID: string): Promise<Room> {
  return api.patch<Room>(`/api/v1/rooms/${roomID}`, { icon_file_id: iconFileID })
}

export function listRoomMembers(roomID: string, signal?: AbortSignal): Promise<RoomMember[]> {
  return api.get<RoomMember[]>(`/api/v1/rooms/${roomID}/members`, signal)
}

export interface RoomInvitationResult {
  mail_sent: boolean
  invite_url?: string
}

export function addRoomMember(roomID: string, email: string, role: Exclude<RoomRole, 'owner'>): Promise<RoomInvitationResult> {
  return api.post(`/api/v1/rooms/${roomID}/members`, { email, role })
}

export function removeRoomMember(roomID: string, userID: string): Promise<void> {
  return api.delete(`/api/v1/rooms/${roomID}/members/${userID}`)
}
export interface RoomReaction {
  user_id?: string
  guest_session_id?: string
  emoji: string
  display_name: string
}

export interface RoomReactionSummary {
  emoji: string
  count: number
  names: string[]
}

export function summarizeRoomReactions(reactions: RoomReaction[] = []): RoomReactionSummary[] {
  const summaries = new Map<string, RoomReactionSummary>()
  for (const reaction of reactions) {
    const summary = summaries.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, names: [] }
    const displayName = reaction.display_name?.trim() || 'Ukendt bruger'
    summary.count += 1
    if (!summary.names.includes(displayName)) summary.names.push(displayName)
    summaries.set(reaction.emoji, summary)
  }
  return [...summaries.values()]
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
  reactions: RoomReaction[]
}

export interface RoomMessagePage {
  messages: RoomMessage[]
  next_cursor?: string
}

export interface DirectConversation {
  id: string
  kind: 'direct' | 'group'
  owner_user_id: string
  name?: string
  source_room_id: string
  source_room_name: string
  source_room_slug: string
  other_user_id: string
  other_display_name: string
  other_email: string
  created_at: string
  updated_at: string
  unread_count: number
  member_count: number
}

export interface DirectMessage {
  id: string
  conversation_id: string
  sender_user_id: string
  sender_name: string
  body: string
  reply_to_message_id?: string
  created_at: string
  edited_at?: string
  deleted_at?: string
}

export interface DirectMessagePage {
  messages: DirectMessage[]
  next_cursor?: string
}

export interface DirectConversationMember {
  user_id: string
  display_name: string
  email: string
  added_at: string
}

export interface DirectResource {
  id: string
  conversation_id: string
  file_id: string
  added_by: string
  message_id?: string
  created_at: string
  name: string
  mime_type?: string
}

export function listDirectConversations(signal?: AbortSignal): Promise<DirectConversation[]> {
  return api.get<DirectConversation[]>('/api/v1/rooms/direct-conversations', signal)
}

export function createDirectConversation(roomID: string, userID: string): Promise<DirectConversation> {
  return api.post<DirectConversation>('/api/v1/rooms/direct-conversations', { room_id: roomID, user_id: userID })
}

export function createGroupConversation(roomID: string, name: string, memberIDs: string[]): Promise<DirectConversation> {
  return api.post<DirectConversation>('/api/v1/rooms/group-conversations', { room_id: roomID, name, member_ids: memberIDs })
}

export function renameDirectConversation(conversationID: string, name: string): Promise<DirectConversation> {
  return api.patch<DirectConversation>(`/api/v1/rooms/direct-conversations/${conversationID}`, { name })
}

export function listDirectMessages(conversationID: string, cursor?: string, signal?: AbortSignal): Promise<DirectMessagePage> {
  const query = new URLSearchParams({ limit: '50' })
  if (cursor) query.set('cursor', cursor)
  return api.get<DirectMessagePage>(`/api/v1/rooms/direct-conversations/${conversationID}/messages?${query}`, signal)
}

export function createDirectMessage(conversationID: string, body: string, replyTo?: string): Promise<DirectMessage> {
  return api.post<DirectMessage>(`/api/v1/rooms/direct-conversations/${conversationID}/messages`, { body, reply_to_message_id: replyTo })
}

export function markDirectConversationRead(conversationID: string): Promise<void> {
  return api.post<void>(`/api/v1/rooms/direct-conversations/${conversationID}/read`, {})
}

export function listDirectConversationMembers(conversationID: string, signal?: AbortSignal): Promise<DirectConversationMember[]> {
  return api.get<DirectConversationMember[]>(`/api/v1/rooms/direct-conversations/${conversationID}/members`, signal)
}

export function listDirectResources(conversationID: string, signal?: AbortSignal): Promise<DirectResource[]> {
  return api.get<DirectResource[]>(`/api/v1/rooms/direct-conversations/${conversationID}/resources`, signal)
}

export function addDirectFileResource(conversationID: string, fileID: string, messageID: string): Promise<DirectResource> {
  return api.post<DirectResource>(`/api/v1/rooms/direct-conversations/${conversationID}/resources`, { file_id: fileID, message_id: messageID })
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
  message_id?: string
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
export function addRoomResource(roomID: string, resourceType: RoomResourceType, resourceID: string, messageID?: string): Promise<RoomResource> {
  return api.post<RoomResource>(`/api/v1/rooms/${roomID}/resources`, { resource_type: resourceType, resource_id: resourceID, message_id: messageID })
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
  email?: string
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

export function createRoomInvite(roomID: string, input: CreateRoomInviteInput): Promise<{ invite: RoomInvite; invite_url: string; mail_sent: boolean }> {
  return api.post(`/api/v1/rooms/${roomID}/invites`, input)
}

export function revokeRoomInvite(roomID: string, inviteID: string): Promise<void> {
  return api.delete(`/api/v1/rooms/${roomID}/invites/${inviteID}`)
}

export interface RoomGuestSession {
  id: string
  invite_id: string
  display_name: string
  expires_at: string
  last_accessed_at?: string
  created_at: string
}

export function listRoomGuestSessions(roomID: string, signal?: AbortSignal): Promise<RoomGuestSession[]> {
  return api.get<RoomGuestSession[]>(`/api/v1/rooms/${roomID}/guest-sessions`, signal)
}

export function revokeRoomGuestSession(roomID: string, sessionID: string): Promise<void> {
  return api.delete(`/api/v1/rooms/${roomID}/guest-sessions/${sessionID}`)
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
export function addGuestRoomReaction(roomID: string, messageID: string, emoji: string): Promise<void> {
  return api.post(`/api/v1/guest/rooms/${roomID}/messages/${messageID}/reactions`, { emoji })
}

export function removeGuestRoomReaction(roomID: string, messageID: string, emoji: string): Promise<void> {
  return api.delete(`/api/v1/guest/rooms/${roomID}/messages/${messageID}/reactions?emoji=${encodeURIComponent(emoji)}`)
}

export function logoutGuestRoom(): Promise<void> {
  return api.post('/api/v1/guest/rooms/logout', {})
}
