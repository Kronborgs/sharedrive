import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  uploads: [] as Array<{ start: ReturnType<typeof vi.fn>; options: Record<string, unknown> }>,
}))

vi.mock('@/lib/api', () => ({ api: { post: mocks.post } }))
vi.mock('tus-js-client', () => ({
  Upload: class MockUpload {
    start = vi.fn()
    constructor(_file: File, readonly options: Record<string, unknown>) {
      mocks.uploads.push(this)
    }
  },
}))

import { uploadGuestRoomTus } from './guest-room-upload'

describe('guest Room TUS upload', () => {
  beforeEach(() => {
    mocks.post.mockReset()
    mocks.uploads.length = 0
  })

  it('uses a scoped token and server-selected folder', async () => {
    mocks.post.mockResolvedValue({ token: 'scoped', folder_id: 'folder', max_file_bytes: 100 })
    const promise = uploadGuestRoomTus('room', new File(['hello'], 'hello.txt', { type: 'text/plain' }), vi.fn())
    await vi.waitFor(() => expect(mocks.uploads).toHaveLength(1))
    expect(mocks.post).toHaveBeenCalledWith('/api/v1/guest/rooms/room/upload-token', {})
    expect(mocks.uploads[0].options).toMatchObject({
      endpoint: '/upload/',
      headers: { 'X-Upload-Token': 'scoped' },
      metadata: { filename: 'hello.txt', filetype: 'text/plain', folder_id: 'folder' },
    })
    ;(mocks.uploads[0].options.onSuccess as () => void)()
    await promise
  })
})
