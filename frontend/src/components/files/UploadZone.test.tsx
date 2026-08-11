// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settings: undefined as undefined | {
    direct_uploads_enabled?: boolean
    upload_endpoint?: string
  },
  apiPost: vi.fn(),
  invalidateQueries: vi.fn(),
  tusUploads: [] as Array<{
    start: ReturnType<typeof vi.fn>
    abort: ReturnType<typeof vi.fn>
    options: {
      endpoint: string
      metadata: Record<string, string>
      headers?: Record<string, string>
      onError: (error: Error) => void
    }
  }>,
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mocks.settings }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: mocks.apiPost,
  },
}))

vi.mock('tus-js-client', () => ({
  Upload: class MockTusUpload {
    start = vi.fn()
    abort = vi.fn()

    constructor(_file: File, readonly options: (typeof mocks.tusUploads)[number]['options']) {
      mocks.tusUploads.push(this)
    }
  },
}))

import { useUploader } from './UploadZone'

describe('useUploader', () => {
  beforeEach(() => {
    mocks.settings = undefined
    mocks.apiPost.mockReset()
    mocks.invalidateQueries.mockReset()
    mocks.tusUploads.length = 0
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))
    mocks.apiPost.mockImplementation((url: string) => {
      if (url === '/api/v1/upload-token') return Promise.resolve({ token: 'upload-token' })
      return Promise.resolve({})
    })
  })

  it('uploads through multipart using the request target folder', async () => {
    const { result } = renderHook(() => useUploader('current-folder', ['files', 'current-folder']))
    const file = new File(['content'], 'report.txt')

    await act(async () => {
      await result.current.startUpload([{ file, overwrite: true, targetFolderId: 'target-folder' }])
    })

    const multipartCall = mocks.apiPost.mock.calls.find(([url]) => url === '/api/v1/files/upload')
    expect(multipartCall).toBeDefined()
    const formData = multipartCall?.[1] as FormData
    expect(formData.get('folder_id')).toBe('target-folder')
    expect(formData.get('overwrite')).toBe('1')
    expect(result.current.uploads[0]).toMatchObject({ status: 'done', progress: 100 })
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['files', 'current-folder'] })
  })

  it('falls back to multipart when a direct upload fails before sending bytes', async () => {
    mocks.settings = {
      direct_uploads_enabled: true,
      upload_endpoint: 'https://upload.example.com/upload/',
    }
    const { result } = renderHook(() => useUploader(null))
    const file = new File(['content'], 'report.txt')

    await act(async () => {
      await result.current.startUpload([{ file, targetFolderId: 'target-folder' }])
    })

    expect(mocks.tusUploads).toHaveLength(1)
    expect(mocks.tusUploads[0].options).toMatchObject({
      endpoint: 'https://upload.example.com/upload',
      metadata: { filename: 'report.txt', folder_id: 'target-folder' },
      headers: { 'X-Upload-Token': 'upload-token' },
    })
    expect(mocks.tusUploads[0].start).toHaveBeenCalledOnce()

    act(() => {
      mocks.tusUploads[0].options.onError(new Error('direct upload failed'))
    })

    await waitFor(() => {
      expect(mocks.apiPost.mock.calls.some(([url]) => url === '/api/v1/files/upload')).toBe(true)
    })
    await waitFor(() => {
      expect(result.current.uploads[0]).toMatchObject({ status: 'done', progress: 100 })
    })
  })
})
