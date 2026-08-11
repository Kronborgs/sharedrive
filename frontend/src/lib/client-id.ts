let fallbackSequence = 0

export function createClientId(): string {
  const cryptoObj = globalThis.crypto

  if (typeof cryptoObj?.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }

  if (typeof cryptoObj?.getRandomValues === 'function') {
    // RFC4122 v4 fallback for environments without crypto.randomUUID.
    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80

    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  // IDs are local UI keys, so a monotonic fallback is sufficient here.
  fallbackSequence += 1
  return `id-${Date.now()}-${fallbackSequence}`
}
