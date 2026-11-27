import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { MailcowAuthGate } from './mailcow-auth.js'

export const suiteContext = new AsyncLocalStorage<{ host: string; address: string; scope: string; owner: string; authorization: string; authGate: MailcowAuthGate }>()
const root = process.env.DATA_DIR || path.join(tmpdir(), 'sharedrive-mail-suite')

export function suiteRoot() {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return root
}

function workspaceDirectory(bucket: string, key: string) {
  const name = path.join(suiteRoot(), bucket, key)
  mkdirSync(name, { recursive: true, mode: 0o700 })
  return name
}

function currentScope() {
  const context = suiteContext.getStore()
  if (!context) throw new Error('Sharedrive Mail scope is required')
  return context
}

export function suiteAccountDirectory() {
  return workspaceDirectory('accounts', currentScope().scope)
}

export function suiteProviderDirectory() {
  return workspaceDirectory('providers', createHash('sha256').update(currentScope().host).digest('hex'))
}
