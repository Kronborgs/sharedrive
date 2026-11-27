import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { createProbeServer } from '../src/server.mjs'

const token = 'local-test-token-only-00000000000'
const account = { username: 'user@example.test', password: 'dummy-password', host: 'mail.example.test' }
const ok = { imap: 'ok', smtp: 'ok', caldav: 'ok', carddav: 'ok' }

async function start(t, probe) {
  const server = createProbeServer({ token, probe })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  }))
  const base = `http://127.0.0.1:${server.address().port}`
  return (body, authorization = `Bearer ${token}`) => fetch(`${base}/internal/v1/probe`, {
    method: 'POST',
    headers: { authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('rejects unauthorised, malformed and invalid host before invoking Mailcow', async (t) => {
  let calls = 0
  const request = await start(t, async (credentials) => {
    calls++
    assert.deepEqual(credentials, account)
    return ok
  })

  assert.equal((await request(account, 'Bearer wrong')).status, 401)
  assert.equal((await request(null)).status, 400)
  assert.equal((await request({ ...account, host: 'http://169.254.169.254/' })).status, 400)
  assert.equal((await request({ ...account, password: 'x'.repeat(5000) })).status, 413)
  assert.equal(calls, 0)

  const result = await request(account)
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await result.json(), ok)
  assert.equal(calls, 1)
})

test('omits internal errors and allows retry after a failed probe', async (t) => {
  let calls = 0
  const request = await start(t, async () => {
    if (!calls++) throw new Error('Contains a credential or upstream response')
    return ok
  })
  const failed = await request(account)
  assert.equal(failed.status, 502)
  assert.deepEqual(await failed.json(), { error: 'probe_unavailable' })
  assert.deepEqual(await (await request(account)).json(), ok)
})
