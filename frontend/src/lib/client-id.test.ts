import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClientId } from './client-id'

const originalCrypto = globalThis.crypto

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto })
})

describe('createClientId', () => {
  it('uses crypto.randomUUID when available', () => {
    const randomUUID = vi.fn(() => '123e4567-e89b-42d3-a456-426614174000' as `${string}-${string}-${string}-${string}-${string}`)
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID } })

    expect(createClientId()).toBe('123e4567-e89b-42d3-a456-426614174000')
    expect(randomUUID).toHaveBeenCalledOnce()
  })

  it('creates an RFC4122 UUID with crypto.getRandomValues', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set(Array.from({ length: 16 }, (_, index) => index))
      return bytes
    })
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } })

    expect(createClientId()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
  })

  it('creates distinct monotonic IDs without crypto', () => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
    vi.spyOn(Date, 'now').mockReturnValue(1234)

    const first = createClientId()
    const second = createClientId()
    expect(first).toMatch(/^id-1234-\d+$/)
    expect(second).not.toBe(first)
  })
})