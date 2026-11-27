import { request } from 'node:https'
import { SaxesParser } from 'saxes'

const DAV = 'DAV:'
const collectionTypes = {
  Calendar: ['urn:ietf:params:xml:ns:caldav', 'calendar'],
  Contacts: ['urn:ietf:params:xml:ns:carddav', 'addressbook'],
}
const propertyQuery = '<propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>'
const maxResponseBytes = 1024 * 1024

export function listsDavCollection(xml, collection) {
  const [namespace, name] = collectionTypes[collection]
  const parser = new SaxesParser({ xmlns: true })
  const stack = []
  let propstat
  let found = false

  const is = (element, uri, local) => element?.uri === uri && element.local === local
  parser.on('opentag', element => {
    stack.push(element)
    if (stack.length === 3 && is(stack[0], DAV, 'multistatus') &&
        is(stack[1], DAV, 'response') && is(element, DAV, 'propstat')) {
      propstat = { status: '', matchesType: false }
    }
    if (propstat && stack.length === 6 && is(stack[3], DAV, 'prop') &&
        is(stack[4], DAV, 'resourcetype') && is(element, namespace, name)) {
      propstat.matchesType = true
    }
  })
  parser.on('text', text => {
    if (propstat && stack.length === 4 && is(stack[3], DAV, 'status')) {
      propstat.status += text
    }
  })
  parser.on('closetag', () => {
    if (propstat && stack.length === 3) {
      found ||= propstat.matchesType && /^HTTP\/\d+(?:\.\d+)?\s+200(?:\s|$)/.test(propstat.status.trim())
      propstat = undefined
    }
    stack.pop()
  })
  parser.write(xml).close()
  return found
}

export function sogoCollectionPath(account, collection) {
  return `/SOGo/dav/${encodeURIComponent(account.username)}/${collection}/personal/`
}

export async function checkSogo(address, account, collection) {
  const path = sogoCollectionPath(account, collection)
  const xml = await sogoRequest(address, account, path, 'PROPFIND', propertyQuery, { Depth: '0' }, [207])
  if (!listsDavCollection(xml, collection)) {
    throw new Error('SOGo did not list the requested collection')
  }
}

export async function sogoRequest(address, { host, username, password }, path, method, body, headers, accepted) {
  const auth = Buffer.from(`${username}:${password}`).toString('base64')
  const response = await new Promise((resolve, reject) => {
    const probe = request({
      hostname: address,
      servername: host,
      path,
      method,
      headers: {
        Host: host,
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      signal: AbortSignal.timeout(10_000),
      rejectUnauthorized: true,
    }, resolve)
    probe.once('error', reject)
    probe.end(body)
  })
  if (!accepted.includes(response.statusCode)) {
    response.destroy()
    throw new Error('SOGo request failed')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response) {
    size += chunk.length
    if (size > maxResponseBytes) throw new Error('SOGo response is too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}
