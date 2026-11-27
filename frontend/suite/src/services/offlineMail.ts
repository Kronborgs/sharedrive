import { offlineMailKey, offlineMailResetKey } from '../../../src/lib/offline-mail-storage'
import type { MailDetail } from '../types/mail'

const offlineShellCache = 'sharedrive-offline-mail-shell-v1'
const mailApp = '/mail/suite-ui/'
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const maxOfflineMessages = 20
const maxBodyLength = 40_000

interface Vault {
  scope: string
  salt: string
  iv: string
  ciphertext: string
}

export interface OfflineMessage {
  id: string
  subject: string
  from: string
  date: string
  body: string
  truncated: boolean
}

function readVault(value: string | null): Vault | null {
  try {
    return value ? JSON.parse(value) as Vault : null
  } catch {
    return null
  }
}

export function hasOfflineMail(scope?: string): boolean {
  try {
    const vault = readVault(localStorage.getItem(offlineMailKey))
    return Boolean(vault?.ciphertext && (!scope || vault.scope === scope))
  } catch {
    return false
  }
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const value of bytes) binary += String.fromCharCode(value)
  return btoa(binary)
}

function bytes(encoded: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function decrypt(vault: Vault, key: CryptoKey): Promise<OfflineMessage[]> {
  try {
    const data = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(vault.iv), additionalData: encoder.encode(vault.scope) },
      key,
      bytes(vault.ciphertext)
    )
    return JSON.parse(decoder.decode(data)) as OfflineMessage[]
  } catch {
    throw new Error('Kunne ikke låse offlinebeskederne op. Kontrollér adgangssætningen.')
  }
}

export async function unlockOfflineMail(passphrase: string, scope?: string): Promise<OfflineMessage[]> {
  const saved = localStorage.getItem(offlineMailKey)
  const vault = readVault(saved)
  if (!vault || (scope && vault.scope !== scope)) throw new Error('Der er ingen gemte offlinebeskeder.')
  const key = await deriveKey(passphrase, bytes(vault.salt))
  const messages = await decrypt(vault, key)
  if (saved !== localStorage.getItem(offlineMailKey)) throw new Error('Offlinebeskederne er blevet ændret. Prøv igen.')
  return messages
}

async function prepareOfflineShell() {
  const registration = await navigator.serviceWorker?.getRegistration()
  if (!registration?.active) throw new Error('Genindlæs Mail, før du gemmer den første offlinebesked.')

  const response = await fetch(mailApp, { cache: 'reload', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error('Kunne ikke klargøre Mail til offlinebrug.')
  const html = new DOMParser().parseFromString(await response.clone().text(), 'text/html')
  if (!html.querySelector('meta[name="sharedrive-mail-suite"]')) throw new Error('Kunne ikke klargøre Mail til offlinebrug.')
  const assets = Array.from(html.querySelectorAll('script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]'), node =>
    new URL(node.getAttribute('src') ?? node.getAttribute('href') ?? '', location.origin))
  if (!assets.length || assets.some(url => url.origin !== location.origin || !url.pathname.startsWith(mailApp + 'assets/'))) {
    throw new Error('Kunne ikke finde Mail-appens offlinefiler.')
  }
  const cache = await caches.open(offlineShellCache)
  await cache.addAll(assets.map(url => new Request(url, { cache: 'reload', signal: AbortSignal.timeout(10_000) })))
  await cache.put(mailApp, response)
}

export async function saveOfflineMail(scope: string, passphrase: string, message: MailDetail, plainBody: string) {
  const saved = localStorage.getItem(offlineMailKey)
  const generation = localStorage.getItem(offlineMailResetKey)
  const vault = readVault(saved)
  if (vault && vault.scope !== scope) {
    throw new Error('Denne browser har offlinebeskeder for en anden konto. Fjern dem først.')
  }
  if (!vault && passphrase.length < 12) throw new Error('Brug en adgangssætning på mindst 12 tegn.')
  if (!plainBody.trim()) throw new Error('Denne mail har ingen tekst at gemme offline.')

  const salt = vault ? bytes(vault.salt) : crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(passphrase, salt)
  const entries = vault ? await decrypt(vault, key) : []
  const snapshot: OfflineMessage = {
    id: message.id,
    subject: message.subject.slice(0, 512),
    from: message.from.map(sender => sender.name || sender.address).join(', ').slice(0, 512),
    date: message.date,
    body: plainBody.slice(0, maxBodyLength),
    truncated: plainBody.length > maxBodyLength
  }
  const latest = [snapshot, ...entries.filter(entry => entry.id !== snapshot.id)]
  if (latest.length > maxOfflineMessages) {
    throw new Error('Du har gemt 20 mails offline. Ryd offlinebeskederne, før du gemmer flere.')
  }

  await prepareOfflineShell()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(scope) },
    key,
    encoder.encode(JSON.stringify(latest))
  )
  if (saved !== localStorage.getItem(offlineMailKey) || generation !== localStorage.getItem(offlineMailResetKey)) {
    throw new Error('Offlinebeskederne er blevet ændret. Prøv igen.')
  }

  localStorage.setItem(offlineMailKey, JSON.stringify({
    scope, salt: base64(salt), iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext))
  }))
}
