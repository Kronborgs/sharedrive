import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ api: mocks }))

import {
  addRoomMember,
  archiveRoom,
  createGroupConversation,
  createRoom,
  getRoom,
  listRoomMembers,
  listRooms,
  removeRoomMember,
  totalRoomUnread,
  totalDirectUnread,
  updateRoom,
} from './rooms'

describe('Rooms API client', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
  })

  it('uses the Room collection endpoints', () => {
    listRooms()
    createRoom('Project Alpha')

    expect(mocks.get).toHaveBeenCalledWith('/api/v1/rooms', undefined)
    expect(mocks.post).toHaveBeenCalledWith('/api/v1/rooms', { name: 'Project Alpha' })
  })

  it('creates a group from the source private conversation', () => {
    createGroupConversation('conversation-1', 'Projektgruppen', ['user-3'])

    expect(mocks.post).toHaveBeenCalledWith('/api/v1/rooms/group-conversations', {
      source_conversation_id: 'conversation-1',
      name: 'Projektgruppen',
      member_ids: ['user-3'],
    })
  })

  it('uses a Room id for detail mutations and member operations', () => {
    getRoom('room-1')
    updateRoom('room-1', 'Renamed')
    archiveRoom('room-1')
    listRoomMembers('room-1')
    addRoomMember('room-1', 'anna@example.com', 'moderator')
    removeRoomMember('room-1', 'user-2')

    expect(mocks.get).toHaveBeenCalledWith('/api/v1/rooms/room-1', undefined)
    expect(mocks.patch).toHaveBeenCalledWith('/api/v1/rooms/room-1', { name: 'Renamed' })
    expect(mocks.post).toHaveBeenCalledWith('/api/v1/rooms/room-1/archive', {})
    expect(mocks.get).toHaveBeenCalledWith('/api/v1/rooms/room-1/members', undefined)
    expect(mocks.post).toHaveBeenCalledWith('/api/v1/rooms/room-1/members', {
      email: 'anna@example.com', role: 'moderator',
    })
    expect(mocks.delete).toHaveBeenCalledWith('/api/v1/rooms/room-1/members/user-2')
  })

  it('adds unread messages across Rooms without returning negative counts', () => {
    const rooms = [
      { unread_count: 3 },
      { unread_count: 0 },
      { unread_count: -2 },
      { unread_count: 7 },
    ] as Parameters<typeof totalRoomUnread>[0]

    expect(totalRoomUnread(rooms)).toBe(10)
  })

  it('adds unread direct messages without returning negative counts', () => {
    const conversations = [
      { unread_count: 1 },
      { unread_count: 4 },
      { unread_count: -3 },
    ] as Parameters<typeof totalDirectUnread>[0]

    expect(totalDirectUnread(conversations)).toBe(5)
  })
})
