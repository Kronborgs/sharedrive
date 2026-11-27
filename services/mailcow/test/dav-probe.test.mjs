import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listsDavCollection } from '../src/dav-probe.mjs'

const multistatus = properties => `
  <multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="urn:ietf:params:xml:ns:carddav">
    <response><href>/SOGo/dav/mailbox/</href>${properties}</response>
  </multistatus>`
const propstat = (type, status) => `
  <propstat><prop><resourcetype><collection/>${type}</resourcetype></prop>
  <status>HTTP/1.1 ${status}</status></propstat>`

test('checks the requested collection type in a successful DAV property response', () => {
  const calendar = propstat('<c:calendar/>', '200 OK')
  const contacts = propstat('<a:addressbook/>', '200 OK')
  assert.equal(listsDavCollection(multistatus(calendar), 'Calendar'), true)
  assert.equal(listsDavCollection(multistatus(contacts), 'Contacts'), true)
  assert.equal(listsDavCollection(multistatus(calendar), 'Contacts'), false)
  assert.equal(listsDavCollection(multistatus(propstat('', '200 OK')), 'Calendar'), false)
  assert.equal(listsDavCollection(multistatus(propstat('<c:calendar/>', '403 Forbidden') + contacts), 'Calendar'), false)
  assert.throws(() => listsDavCollection('<broken>', 'Calendar'))
})
