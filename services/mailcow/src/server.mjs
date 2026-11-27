import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { hasOperation } from './operations.mjs'
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

async function readAccount(request, maxBytes, diagnostic) {
  const chunks = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maxBytes) return null
    chunks.push(chunk)
  }
  const account = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!account || typeof account !== 'object' || Array.isArray(account)) return null
  const { username, password, host, arguments: input } = account
  if (
    Object.keys(account).length !== (input === undefined ? 3 : 4) ||
    (diagnostic && input !== undefined) ||
    !isMailcowHostname(host) ||
    typeof username !== 'string' ||
    username.length > 254 ||
    !mailbox.test(username) ||
    typeof password !== 'string' ||
    password.length < 1 ||
    password.length > 1024 ||
    /[\x00-\x1f\x7f]/.test(password)
  ) return null
  return { account: { username, password, host }, input }
}

export function createProbeServer({ token, probe, operation }) {
  const expected = digest(`Bearer ${token}`)
  let busy = false
  let active = 0

  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000, connectionsCheckingInterval: 1_000 }, async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      return reply(response, 200, { status: 'ok' })
    }
    const name = request.url?.startsWith('/internal/v1/') ? request.url.slice('/internal/v1/'.length) : ''
    const diagnostic = name === 'probe'
    if (request.method !== 'POST' || !(diagnostic || (operation && hasOperation(name)))) {
      return reply(response, 404, { error: 'not_found' })
    }
    if (!timingSafeEqual(digest(request.headers.authorization ?? ''), expected)) {
      return reply(response, 401, { error: 'unauthorized' })
    }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      return reply(response, 415, { error: 'unsupported_media_type' })
    }
    const maxBytes = diagnostic ? maxBodyBytes : 96 * 1024
    if (Number(request.headers['content-length']) > maxBytes) {
      response.setHeader('Connection', 'close')
      return reply(response, 413, { error: 'request_too_large' })
    }
    if (active >= 6 || (diagnostic && busy)) return reply(response, 429, { error: 'probe_in_progress' })

    if (diagnostic) busy = true
    active++
    try {
      const payload = await readAccount(request, maxBytes, diagnostic).catch(() => null)
      if (!payload) {
        response.setHeader('Connection', 'close')
        return reply(response, 400, { error: 'invalid_account' })
      }
      const result = diagnostic ? await probe(payload.account) : await operation(name, payload.account, payload.input)
      if (result === null) return reply(response, 400, { error: 'invalid_arguments' })
      return reply(response, 200, result)
    } catch {
      return reply(response, 502, { error: 'probe_unavailable' })
    } finally {
      active--
      if (diagnostic) busy = false
    }
  })
}
