import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatMboxMessage, mboxMaxBytes, parseMbox } from '../src/mbox.ts'

test('MBOX round trip preserves mail headers, binary bytes and From quoting', () => {
  const first = Buffer.from('From: first@example.test\r\nSubject: Arkiv\r\n\r\nFrom sender Sat Jan  1 00:00:00 2000\r\n>From quote\r\n', 'latin1')
  const second = Buffer.from('Subject: MIME\n\nBytes: \u00ff\u00a0\n', 'latin1')
  const date = new Date('2026-11-27T14:10:00Z')
  const archive = Buffer.concat([formatMboxMessage(first, date), formatMboxMessage(second)])
  const messages = parseMbox(archive)
  assert.deepEqual(messages.map(({ source }) => source), [first, second])
  assert.equal(messages[0].receivedAt.toISOString(), date.toISOString())
  assert.match(archive.toString('latin1'), /\n>>From quote\r\n/)
})

test('imports Mozilla-style envelope dates with a timezone', () => {
  const archive = Buffer.from('From - Fri Nov 27 15:10:00 +0100 2026\nSubject: Test\n\nMail\n\n')
  assert.equal(parseMbox(archive)[0].receivedAt.toISOString(), '2026-11-27T14:10:00.000Z')
})

test('rejects oversized, empty and malformed archives before importing', () => {
  assert.throws(() => parseMbox(Buffer.alloc(mboxMaxBytes + 1)), /20 MiB/)
  assert.throws(() => parseMbox(Buffer.from('Subject: EML\r\n')), /MBOX-fil/)
  const valid = formatMboxMessage(Buffer.from('Subject: Valid\r\n\r\nMail\r\n'))
  const invalid = formatMboxMessage(Buffer.from('Missing header\r\n'))
  assert.throws(() => parseMbox(Buffer.concat([valid, invalid])), /nr\. 2/)
})
