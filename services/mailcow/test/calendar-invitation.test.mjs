import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildInvitationSeries, readCalendarInvitation } from '../src/calendarInvitation.ts'
import { buildCalendarExportIcs, parseIcsToEvents } from '../suite/src/services/icalMapper.ts'

function invitation(method, eventFields) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:' + method, 'BEGIN:VEVENT',
    'UID:original@example.test', ...eventFields, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
}

test('reads a folded meeting subject and keeps its original UID', () => {
  const parsed = readCalendarInvitation(invitation('REQUEST', [
    'DTSTART:20300219T080000Z', 'DTEND:20300219T090000Z', 'SUMMARY:Langt emne ',
    ' fortsætter her', 'ORGANIZER:mailto:owner@example.test'
  ]))
  assert.equal(parsed.uid, 'original@example.test')
  assert.equal(parsed.summary, 'Langt emne fortsætter her')
  assert.equal(parsed.organizer, 'owner@example.test')
  assert.equal(parsed.canAddDirectly, true)
})

test('recognizes cancellations and replies without creating a new appointment', () => {
  const cancel = readCalendarInvitation(invitation('CANCEL', ['SUMMARY:Aflyst']))
  assert.equal(cancel.cancelled, true)
  assert.equal(cancel.canAddDirectly, false)
  const reply = readCalendarInvitation(invitation('REPLY', ['DTSTART:20300219T080000Z']))
  assert.equal(reply.method, 'REPLY')
  assert.equal(reply.canAddDirectly, false)
})

test('accepts a series master and recognizes an exception sent on its own', () => {
  const dates = ['DTSTART:20300219T080000Z']
  const recurring = readCalendarInvitation(invitation('REQUEST', [...dates, 'RRULE:FREQ=WEEKLY']))
  assert.equal(recurring.canAddDirectly, true)
  assert.equal(recurring.recurring, true)
  const occurrence = readCalendarInvitation(invitation('REQUEST', [...dates, 'RECURRENCE-ID:20300219T080000Z']))
  assert.equal(occurrence.canAddDirectly, false)
  assert.equal(occurrence.occurrenceUpdate, true)
})

test('preserves a recurring invitation, excluded dates and moved or cancelled occurrences', () => {
  const year = new Date().getFullYear()
  const calUrl = 'https://calendar.example.test/personal/'
  const master = invitation('REQUEST', [
    `DTSTART:${year}0201T100000Z`, `DTEND:${year}0201T110000Z`, 'RRULE:FREQ=WEEKLY;COUNT=4',
    `EXDATE:${year}0208T100000Z`, `RDATE:${year}0301T100000Z`, 'SUMMARY:Fast møde',
    'ORGANIZER:mailto:owner@example.test', 'ATTACH:https://example.test/attachment',
    'BEGIN:VALARM', 'ACTION:EMAIL', 'TRIGGER:-PT5M', 'END:VALARM'
  ])
  const overrides = [
    'BEGIN:VEVENT', 'UID:original@example.test', `RECURRENCE-ID:${year}0215T100000Z`,
    `DTSTART:${year}0216T120000Z`, `DTEND:${year}0216T130000Z`, 'SUMMARY:Flyttet møde', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:original@example.test', `RECURRENCE-ID:${year}0222T100000Z`,
    'STATUS:CANCELLED', 'END:VEVENT'
  ].join('\r\n')
  const raw = master.replace('END:VCALENDAR', overrides + '\r\nEND:VCALENDAR')
  assert.equal(readCalendarInvitation(raw).canAddDirectly, true)
  const stored = buildInvitationSeries(raw)
  assert.match(stored, /SCHEDULE-AGENT=NONE/)
  assert.doesNotMatch(stored, /METHOD:|ATTACH:|BEGIN:VALARM/)
  const occurrences = parseIcsToEvents(stored, calUrl, calUrl + 'series.ics', undefined, false, true)
  assert.deepEqual(occurrences.map(item => item.start.slice(5, 16)), ['02-01T10:00', '02-16T12:00', '03-01T10:00'])
  assert.equal(occurrences[1].title, 'Flyttet møde')
  assert.ok(occurrences.every(item => item.seriesOccurrence && item.uid === 'original@example.test'))
  const exported = buildCalendarExportIcs(occurrences)
  assert.equal(exported.match(/RRULE:/g).length, 1)
  assert.match(exported, /RECURRENCE-ID:/)
})
