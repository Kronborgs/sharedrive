import { describe, expect, it, vi } from 'vitest'
import {
  ensureDirectUploadAvailable,
  isCrossOriginEndpoint,
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