import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { isMailcowHostname } from './network.mjs'

const maxBodyBytes = 4096
const mailbox = /^[A-Za-z0-9.!#$%&'*+=?^_`{|}~-]+@[A-Za-z0-9.-]+$/

function digest(value) {
  return createHash('sha256').update(value).digest()
}

function reply(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

async function readAccount(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maxBodyBytes) return null
    chunks.push(chunk)
  }
  const account = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!account || typeof account !== 'object' || Array.isArray(account)) return null
  const { username, password, host } = account
  if (
    Object.keys(account).length !== 3 ||
    !isMailcowHostname(host) ||
    typeof username !== 'string' ||
    username.length > 254 ||
    !mailbox.test(username) ||
    typeof password !== 'string' ||
    password.length < 1 ||
    password.length > 1024 ||
    /[\x00-\x1f\x7f]/.test(password)
  ) return null
  return { username, password, host }
}

export function createProbeServer({ token, probe }) {
  const expected = digest(`Bearer ${token}`)
  let busy = false

  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000, connectionsCheckingInterval: 1_000 }, async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      return reply(response, 200, { status: 'ok' })
    }
    if (request.method !== 'POST' || request.url !== '/internal/v1/probe') {
      return reply(response, 404, { error: 'not_found' })
    }
    if (!timingSafeEqual(digest(request.headers.authorization ?? ''), expected)) {
      return reply(response, 401, { error: 'unauthorized' })
    }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      return reply(response, 415, { error: 'unsupported_media_type' })
    }
    if (Number(request.headers['content-length']) > maxBodyBytes) {
      response.setHeader('Connection', 'close')
      return reply(response, 413, { error: 'request_too_large' })
    }
    if (busy) return reply(response, 429, { error: 'probe_in_progress' })

    busy = true
    try {
      const account = await readAccount(request).catch(() => null)
      if (!account) {
        response.setHeader('Connection', 'close')
        return reply(response, 400, { error: 'invalid_account' })
      }
      const result = await probe(account)
      return reply(response, 200, result)
    } catch {
      return reply(response, 502, { error: 'probe_unavailable' })
    } finally {
      busy = false
    }
  })
}
