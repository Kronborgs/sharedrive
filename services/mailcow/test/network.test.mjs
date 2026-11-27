import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveMailcowAddress } from '../src/network.mjs'

test('uses a checked public IP and rejects private, mapped and mixed DNS answers', async () => {
  const host = 'mail.example.test'
  function answers(...addresses) {
    return { resolve4(name) { assert.equal(name, host); return Promise.resolve(addresses) } }
  }

  assert.equal(await resolveMailcowAddress(host, answers('8.8.8.8', '1.1.1.1')), '8.8.8.8')
  for (const address of ['127.0.0.1', '192.168.1.9', '169.254.169.254', '100.64.0.1', '::ffff:127.0.0.1']) {
    await assert.rejects(resolveMailcowAddress(host, answers('8.8.8.8', address)))
  }
  await assert.rejects(resolveMailcowAddress('https://mail.example.test', answers('8.8.8.8')))
})
