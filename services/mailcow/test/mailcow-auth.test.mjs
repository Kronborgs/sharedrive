import assert from 'node:assert/strict'
import test from 'node:test'
import { imapLoginRejected, MailcowAuthGate, smtpLoginRejected } from '../suite/src/mailcow-auth.ts'

test('a refused login stops queued and later attempts for the same saved credentials', async () => {
  const gate = new MailcowAuthGate()
  let attempts = 0
  const tryLogin = () => gate.run(async () => {
    attempts++
    throw Object.assign(new Error('IMAP refused login'), { authenticationFailed: true })
  }, imapLoginRejected)

  const simultaneous = await Promise.allSettled([tryLogin(), tryLogin(), tryLogin()])
  assert.ok(simultaneous.every(result => result.status === 'rejected'))
  assert.equal(attempts, 1)
  await assert.rejects(tryLogin(), /Mailcow afviste login/)
  assert.equal(attempts, 1)
  assert.equal(await new MailcowAuthGate().run(async () => 'connected'), 'connected')
})

test('timeouts, permission denials and temporary SMTP errors allow further requests', async () => {
  const gate = new MailcowAuthGate()
  await assert.rejects(gate.run(() => Promise.reject(new Error('IMAP timeout')), imapLoginRejected))
  await assert.rejects(gate.run(() => Promise.reject({ code: 'EAUTH', responseCode: 454 }), smtpLoginRejected))
  assert.equal(await gate.run(async () => 403), 403)
  assert.equal(await gate.run(async () => 200), 200)
})
