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
  createRoom,
  getRoom,
  listRoomMembers,
  listRooms,
  removeRoomMember,
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
})
