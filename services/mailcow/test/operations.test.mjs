import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOperations } from '../src/operations.mjs'

test('invalid folder paging and calendar ranges are rejected before a network connection', async () => {
  const run = createOperations({ smtpPort: 465 })
  const fixture = { host: 'mail.example.invalid', username: 'fixture@example.invalid', password: 'fixture' }
  assert.equal(await run('folder', fixture, { folder: 'INBOX', page: 0, search: '' }), null)
  assert.equal(await run('folder', fixture, { folder: '', page: 1, search: '' }), null)
  assert.equal(await run('calendar', fixture, { start: '2026-11-01', end: '2027-01-01' }), null)
  assert.equal(await run('calendar', fixture, { start: 'invalid', end: '2026-11-30' }), null)
  assert.equal(await run('message', fixture, { folder: '', uid: 4 }), null)
})
