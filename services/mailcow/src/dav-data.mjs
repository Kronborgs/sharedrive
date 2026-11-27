import { createHash, randomUUID } from 'node:crypto'
import { SaxesParser } from 'saxes'
import ICAL from 'ical.js'
import { sogoCollectionPath, sogoRequest } from './dav-probe.mjs'

const davNamespace = 'DAV:'
const calendarNamespace = 'urn:ietf:params:xml:ns:caldav'
const contactNamespace = 'urn:ietf:params:xml:ns:carddav'

function responseData(xml, namespace, field) {
  const parser = new SaxesParser({ xmlns: true })
  const stack = []
  const values = []
  let propstat
  const is = (element, uri, local) => element?.uri === uri && element.local === local
  parser.on('opentag', element => {
    stack.push(element)
    if (stack.length === 3 && is(stack[0], davNamespace, 'multistatus') &&
        is(stack[1], davNamespace, 'response') && is(element, davNamespace, 'propstat')) {
      propstat = { status: '', data: '' }
    }
  })
  const text = value => {
    if (!propstat) return
    if (stack.length === 4 && is(stack[3], davNamespace, 'status')) propstat.status += value
    if (stack.length === 5 && is(stack[3], davNamespace, 'prop') && is(stack[4], namespace, field)) propstat.data += value
  }
  parser.on('text', text)
  parser.on('cdata', text)
  parser.on('closetag', () => {
    if (propstat && stack.length === 3) {
      if (propstat.data && /^HTTP\/\d+(?:\.\d+)?\s+200(?:\s|$)/.test(propstat.status.trim())) values.push(propstat.data)
      propstat = undefined
    }
    stack.pop()
  })
  parser.write(xml).close()
  return values
}

function icalTime(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

export async function listEvents(address, account, range = {}) {
  const now = Date.now()
  const start = icalTime(new Date(range.start ?? now - 86400000))
  const end = icalTime(new Date(range.end ?? now + 30 * 86400000))
  const xml = `<c:calendar-query xmlns:d="DAV:" xmlns:c="${calendarNamespace}">
    <d:prop><c:calendar-data><c:expand start="${start}" end="${end}"/></c:calendar-data></d:prop>
    <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${start}" end="${end}"/></c:comp-filter></c:comp-filter></c:filter>
    </c:calendar-query>`
  const body = await sogoRequest(address, account, sogoCollectionPath(account, 'Calendar'), 'REPORT', xml, { Depth: '1' }, [207])
  return responseData(body, calendarNamespace, 'calendar-data').flatMap(data => {
    try {
      const events = new ICAL.Component(ICAL.parse(data)).getAllSubcomponents('vevent')
      return events.flatMap(component => {
        const event = new ICAL.Event(component)
        if (!event.startDate || !event.endDate) return []
        const start = event.startDate.isDate ? event.startDate.toString() : event.startDate.toJSDate().toISOString()
        const end = event.endDate.isDate ? event.endDate.toString() : event.endDate.toJSDate().toISOString()
        return [{ id: event.uid, title: (event.summary ?? '').slice(0, 240), start, end, allDay: event.startDate.isDate }]
      })
    } catch {
      return []
    }
  }).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 100)
}

export async function createEvent(address, account, { title, start, end }) {
  const id = randomUUID()
  const calendar = new ICAL.Component('vcalendar')
  calendar.updatePropertyWithValue('version', '2.0')
  calendar.updatePropertyWithValue('prodid', '-//Sharedrive//Calendar//EN')
  const event = new ICAL.Component('vevent')
  event.updatePropertyWithValue('uid', id)
  event.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true))
  event.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(new Date(start), true))
  event.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(new Date(end), true))
  event.updatePropertyWithValue('summary', title)
  calendar.addSubcomponent(event)
  await sogoRequest(address, account, sogoCollectionPath(account, 'Calendar') + id + '.ics', 'PUT', calendar.toString(),
    { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' }, [201, 204])
}

function vcardValue(data, field) {
  const line = data.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).find(item =>
    item.split(':', 1)[0].split(';', 1)[0].split('.').at(-1).toUpperCase() === field && item.includes(':'))
  return line?.slice(line.indexOf(':') + 1).replace(/\\([nN,;\\])/g, (_, value) =>
    value.toLowerCase() === 'n' ? '\n' : value) ?? ''
}

export async function listContacts(address, account) {
  const xml = `<c:addressbook-query xmlns:d="DAV:" xmlns:c="${contactNamespace}">
    <d:prop><c:address-data><c:prop name="FN"/><c:prop name="EMAIL"/><c:prop name="TEL"/><c:prop name="UID"/></c:address-data></d:prop>
    <c:filter/><c:limit><c:nresults>100</c:nresults></c:limit></c:addressbook-query>`
  const body = await sogoRequest(address, account, sogoCollectionPath(account, 'Contacts'), 'REPORT', xml, { Depth: '1' }, [207])
  return responseData(body, contactNamespace, 'address-data').slice(0, 100).map(data => ({
    id: vcardValue(data, 'UID') || createHash('sha256').update(data).digest('hex'),
    name: vcardValue(data, 'FN').slice(0, 240),
    email: vcardValue(data, 'EMAIL').slice(0, 254),
    phone: vcardValue(data, 'TEL').slice(0, 100),
  }))
}

function escapeVcard(value) {
  return value.replaceAll('\\', '\\\\').replace(/[;,]/g, '\\$&').replace(/\r?\n/g, '\\n')
}

export async function createContact(address, account, { name, email, phone }) {
  const id = randomUUID()
  const escapedName = escapeVcard(name)
  const card = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:' + id, 'FN:' + escapedName, 'N:' + escapedName + ';;;;',
    ...(email ? ['EMAIL:' + escapeVcard(email)] : []), ...(phone ? ['TEL:' + escapeVcard(phone)] : []), 'END:VCARD', ''].join('\r\n')
  await sogoRequest(address, account, sogoCollectionPath(account, 'Contacts') + id + '.vcf', 'PUT', card,
    { 'Content-Type': 'text/vcard; charset=utf-8', 'If-None-Match': '*' }, [201, 204])
}
