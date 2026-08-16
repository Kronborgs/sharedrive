import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: mocks }))

import {
  acceptRoomInvite, addGuestRoomReaction, addRoomReaction, addRoomResource, createGuestRoomMessage,
  createRoomInvite, createRoomMessage, deleteRoomMessage, getGuestRoom,
  listGuestRoomMessages, listRoomGuestSessions, listRoomInvites, listRoomMessages, listRoomResources,
  logoutGuestRoom, markRoomRead, removeGuestRoomReaction, removeRoomReaction, removeRoomResource,
  revokeRoomGuestSession, revokeRoomInvite, updateRoomMessage,
} from './rooms'

describe('Rooms chat, resources and guest API client', () => {
  beforeEach(() => Object.values(mocks).forEach(mock => mock.mockReset()))

  it('builds message, reaction and read-state requests', () => {
    listRoomMessages('r1', 'cursor')
    createRoomMessage('r1', 'hello', 'reply')
    updateRoomMessage('r1', 'm1', 'edited')
    deleteRoomMessage('r1', 'm1')
    addRoomReaction('r1', 'm1', '❤️')
    removeRoomReaction('r1', 'm1', '❤️')
    markRoomRead('r1', 'm1')

    expect(mocks.get).toHaveBeenCalledWith('/api/v1/rooms/r1/messages?limit=50&cursor=cursor', undefined)
    expect(mocks.post).toHaveBeenCalledWith('/api/v1/rooms/r1/messages', { body: 'hello', reply_to_message_id: 'reply' })
    expect(mocks.patch).toHaveBeenCalledWith('/api/v1/rooms/r1/messages/m1', { body: 'edited' })
    expect(mocks.delete).toHaveBeenCalledWith('/api/v1/rooms/r1/messages/m1')
    expect(mocks.post).toHaveBeenCalledWith('/api/v1/rooms/r1/messages/m1/reactions', { emoji: '❤️' })
    expect(mocks.delete).toHaveBeenCalledWith('/api/v1/rooms/r1/messages/m1/reactions?emoji=%E2%9D%A4%EF%B8%8F')
    expect(mocks.put).toHaveBeenCalledWith('/api/v1/rooms/r1/read-state', { message_id: 'm1' })
  })

  it('builds resource and invitation requests', () => {
    listRoomResources('r1')
    addRoomResource('r1', 'file', 'f1')
    removeRoomResource('r1', 'link1')
    listRoomInvites('r1')
    createRoomInvite('r1', { label: 'Guest', expires_hours: 24, can_chat: true, can_upload: false, can_voice: false, can_share_screen: false })
    revokeRoomInvite('r1', 'i1')
    listRoomGuestSessions('r1')
    revokeRoomGuestSession('r1', 's1')

    expect(mocks.get).toHaveBeenCalledWith('/api/v1/rooms/r1/resources', undefined)
    expect(mocks.post).toHaveBeenCalledWith('/api/v1/rooms/r1/resources', { resource_type: 'file', resource_id: 'f1' })
    expect(mocks.delete).toHaveBeenCalledWith('/api/v1/rooms/r1/resources/link1')
    expect(mocks.get).toHaveBeenCalledWith('/api/v1/rooms/r1/invites', undefined)
    expect(mocks.delete).toHaveBeenCalledWith('/api/v1/rooms/r1/invites/i1')
    expect(mocks.get).toHaveBeenCalledWith('/api/v1/rooms/r1/guest-sessions', undefined)
    expect(mocks.delete).toHaveBeenCalledWith('/api/v1/rooms/r1/guest-sessions/s1')
  })

  it('builds public guest-session requests and encodes the token', () => {
    acceptRoomInvite('token/with slash', 'External')
    getGuestRoom('r1')
    listGuestRoomMessages('r1')
    createGuestRoomMessage('r1', 'hello')
    addGuestRoomReaction('r1', 'm1', '🎉')
    removeGuestRoomReaction('r1', 'm1', '🎉')
    logoutGuestRoom()

    expect(mocks.post).toHaveBeenCalledWith('/api/v1/public/rooms/invitations/token%2Fwith%20slash/accept', { display_name: 'External' })
    expect(mocks.get).toHaveBeenCalledWith('/api/v1/guest/rooms/r1', undefined)
    expect(mocks.get).toHaveBeenCalledWith('/api/v1/guest/rooms/r1/messages?limit=50', undefined)
    expect(mocks.post).toHaveBeenCalledWith('/api/v1/guest/rooms/r1/messages', { body: 'hello' })
    expect(mocks.post).toHaveBeenCalledWith('/api/v1/guest/rooms/r1/messages/m1/reactions', { emoji: '🎉' })
    expect(mocks.delete).toHaveBeenCalledWith('/api/v1/guest/rooms/r1/messages/m1/reactions?emoji=%F0%9F%8E%89')
    expect(mocks.post).toHaveBeenCalledWith('/api/v1/guest/rooms/logout', {})
  })
})
