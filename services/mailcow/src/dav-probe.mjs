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

export async function checkSogo(address, { host, username, password }, collection) {
  const path = `/SOGo/dav/${encodeURIComponent(username)}/${collection}/`
  const auth = Buffer.from(`${username}:${password}`).toString('base64')
  const response = await new Promise((resolve, reject) => {
    const probe = request({
      hostname: address,
      servername: host,
      path,
      method: 'PROPFIND',
      headers: {
        Host: host,
        Authorization: `Basic ${auth}`,
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(propertyQuery),
      },
      signal: AbortSignal.timeout(10_000),
      rejectUnauthorized: true,
    }, resolve)
    probe.once('error', reject)
    probe.end(propertyQuery)
  })

  if (response.statusCode !== 207) {
    response.destroy()
    throw new Error('SOGo collection unavailable')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response) {
    size += chunk.length
    if (size > maxResponseBytes) throw new Error('SOGo response is too large')
    chunks.push(chunk)
  }
  if (!listsDavCollection(Buffer.concat(chunks).toString('utf8'), collection)) {
    throw new Error('SOGo did not list the requested collection')
  }
}
