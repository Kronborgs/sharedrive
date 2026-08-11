import { describe, expect, it, vi } from 'vitest'
import {
  createTusHeaders,
  createTusMetadata,
  ensureDirectUploadAvailable,
  isCrossOriginEndpoint,
  performMultipartUpload,
  resolveUploadRouting,
  shouldFallbackToMultipart,
} from './upload-routing'

describe('resolveUploadRouting', () => {
  it('uses the same-origin TUS endpoint without direct upload by default', () => {
    expect(resolveUploadRouting()).toEqual({ endpoint: '/upload/', directUpload: false })
  })

  it('derives the TUS endpoint from a direct upload URL', () => {
    expect(resolveUploadRouting({ direct_upload_url: 'https://upload.example.com///' })).toEqual({
      endpoint: 'https://upload.example.com/upload/',
      directUpload: true,
    })
  })

  it('prefers an explicit upload endpoint and enabled flag', () => {
    expect(resolveUploadRouting({
      direct_upload_url: 'https://upload.example.com',
      upload_endpoint: 'https://uploads.example.net/tus///',
      direct_uploads_enabled: false,
    })).toEqual({ endpoint: 'https://uploads.example.net/tus', directUpload: false })
  })
})

describe('isCrossOriginEndpoint', () => {
  const origin = 'https://drive.example.com'

  it('recognizes same-origin and cross-origin endpoints', () => {
    expect(isCrossOriginEndpoint('/upload/', origin)).toBe(false)
    expect(isCrossOriginEndpoint('https://upload.example.com/upload/', origin)).toBe(true)
  })

  it('rejects invalid endpoint URLs', () => {
    expect(isCrossOriginEndpoint('http://[invalid', origin)).toBe(false)
  })
})

describe('ensureDirectUploadAvailable', () => {
  const origin = 'https://drive.example.com'

  it('does not probe the same-origin endpoint', async () => {
    const request = vi.fn()
    await ensureDirectUploadAvailable('/upload/', origin, request)
    expect(request).not.toHaveBeenCalled()
  })

  it('accepts a healthy direct endpoint', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    await ensureDirectUploadAvailable('https://upload.example.com/upload/', origin, request)
    expect(request).toHaveBeenCalledWith('https://upload.example.com/upload/', { method: 'OPTIONS', mode: 'cors' })
  })

  it('rejects an unavailable direct endpoint', async () => {
    const request = vi.fn().mockResolvedValue({ ok: false, status: 502 })
    await expect(ensureDirectUploadAvailable('https://upload.example.com/upload/', origin, request))
      .rejects.toThrow('Direct upload unavailable (502)')
  })
})

describe('shouldFallbackToMultipart', () => {
  const origin = 'https://drive.example.com'

  it('only falls back before bytes reach a cross-origin endpoint', () => {
    expect(shouldFallbackToMultipart('https://upload.example.com/upload/', origin, 0)).toBe(true)
    expect(shouldFallbackToMultipart('https://upload.example.com/upload/', origin, 1)).toBe(false)
    expect(shouldFallbackToMultipart('/upload/', origin, 0)).toBe(false)
  })
})

describe('createTusMetadata', () => {
  it('adds folder and overwrite metadata when configured', () => {
    const file = new File(['data'], 'report.txt')
    expect(createTusMetadata({ file, overwrite: true }, 'folder-1')).toEqual({
      filename: 'report.txt',
      folder_id: 'folder-1',
      overwrite: '1',
    })
    expect(createTusMetadata({ file }, null)).toEqual({ filename: 'report.txt' })
  })
})

describe('createTusHeaders', () => {
  const origin = 'https://drive.example.com'

  it('only issues tokens for cross-origin uploads', async () => {
    const issueToken = vi.fn().mockResolvedValue({ token: 'token-1' })
    await expect(createTusHeaders('/upload/', origin, null, issueToken)).resolves.toBeUndefined()
    expect(issueToken).not.toHaveBeenCalled()

    await expect(createTusHeaders('https://upload.example.com/upload/', origin, 'folder-1', issueToken))
      .resolves.toEqual({ 'X-Upload-Token': 'token-1' })
    expect(issueToken).toHaveBeenCalledWith({ folder_id: 'folder-1' })
  })

  it('handles root uploads and missing tokens', async () => {
    const issueToken = vi.fn().mockResolvedValue({})
    await expect(createTusHeaders('https://upload.example.com/upload/', origin, null, issueToken))
      .resolves.toBeUndefined()
    expect(issueToken).toHaveBeenCalledWith({})
  })
})

describe('performMultipartUpload', () => {
  it('uploads form data and reports completion', async () => {
    const post = vi.fn().mockResolvedValue({})
    const update = vi.fn()
    const refresh = vi.fn()
    await performMultipartUpload({ file: new File(['data'], 'report.txt'), overwrite: true }, 'folder-1', {
      post,
      update,
      refresh,
    })

    const formData = post.mock.calls[0][0] as FormData
    expect(formData.get('folder_id')).toBe('folder-1')
    expect(formData.get('overwrite')).toBe('1')
    expect(update).toHaveBeenNthCalledWith(1, { status: 'uploading' })
    expect(update).toHaveBeenNthCalledWith(2, { progress: 100, status: 'done' })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('reports upload failures without refreshing', async () => {
    const update = vi.fn()
    const refresh = vi.fn()
    await performMultipartUpload({ file: new File(['data'], 'report.txt') }, null, {
      post: vi.fn().mockRejectedValue(new Error('network failed')),
      update,
      refresh,
    })
    expect(update).toHaveBeenLastCalledWith({ status: 'error', error: 'network failed' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('uses a stable message for non-Error failures', async () => {
    const update = vi.fn()
    await performMultipartUpload({ file: new File(['data'], 'report.txt') }, null, {
      post: vi.fn().mockRejectedValue('network failed'),
      update,
      refresh: vi.fn(),
    })
    expect(update).toHaveBeenLastCalledWith({ status: 'error', error: 'Upload failed' })
  })
})