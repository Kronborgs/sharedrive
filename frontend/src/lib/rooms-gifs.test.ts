import { describe, expect, it } from 'vitest'
import { isRemoteGIFURL } from './rooms-gifs'

describe('Rooms remote GIF URLs', () => {
  it('accepts direct HTTPS Giphy and Tenor GIF URLs', () => {
    expect(isRemoteGIFURL('https://media.giphy.com/media/example/giphy.gif')).toBe(true)
    expect(isRemoteGIFURL('https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExeW1lNmtseTlscjZpNjFzNnY0NDVwNDd3eTZ6ajYyMWU3ZXRxYXdpMCZlcD12MV9naWZzX3NlYXJjaCZjdD1n/LQ6hYsehFSPVC/giphy.gif')).toBe(true)
    expect(isRemoteGIFURL('https://media.tenor.com/example.gif')).toBe(true)
  })

  it('rejects non-GIF, non-HTTPS and unrelated URLs', () => {
    expect(isRemoteGIFURL('http://media.giphy.com/media/example/giphy.gif')).toBe(false)
    expect(isRemoteGIFURL('https://example.com/image.gif')).toBe(false)
    expect(isRemoteGIFURL('https://media.giphy.com/image.png')).toBe(false)
    expect(isRemoteGIFURL('hello')).toBe(false)
  })
})
