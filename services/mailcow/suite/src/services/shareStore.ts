import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { suiteContext, suiteRoot, suiteAccountDirectory } from '../sharedrive-context.js'

type ShareInput = {
  label: string
  calendarUrls: string[]
  calendarNames: string[]
  hideDetails: boolean
}

type ShareRecord = ShareInput & {
  token: string
  owner: string
  scope: string
  createdAt: string
}

export const isShareToken = (token: string) => /^[a-zA-Z0-9_-]{24}$/.test(token)

function shareFile(token: string) {
  return path.join(suiteRoot(), 'calendar-link-owners', token + '.json')
}

function readShare(token: string): ShareRecord | undefined {
  if (!isShareToken(token)) return undefined
  try {
    return JSON.parse(fs.readFileSync(shareFile(token), 'utf8')) as ShareRecord
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

export function shareOwner(token: string) {
  const record = readShare(token)
  return record ? {owner: record.owner, scope: record.scope} : undefined
}

export function resolveShareToken(token: string) {
  const record = readShare(token)
  const context = suiteContext.getStore()
  if (!record || !context || record.owner !== context.owner || record.scope !== context.scope) return undefined
  return record
}

function publicInfo(record: ShareRecord) {
  const { token, label, calendarUrls, calendarNames, hideDetails, createdAt } = record
  return { token, label, calendarUrls, calendarNames, hideDetails, createdAt }
}

function accountLinks() {
  const directory = path.join(suiteAccountDirectory(), 'calendar-links')
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

export function listSharesForUser() {
  return fs.readdirSync(accountLinks()).flatMap(token => {
    const record = resolveShareToken(token)
    return record ? [publicInfo(record)] : []
  })
}

export function createShareLink(input: ShareInput) {
  const context = suiteContext.getStore()
  if (!context) throw new Error('Sharedrive Mail scope is required')
  const token = randomBytes(18).toString('base64url')
  const record = { ...input, token, owner: context.owner, scope: context.scope, createdAt: new Date().toISOString() }
  const file = shareFile(token)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const link = path.join(accountLinks(), token)
  fs.writeFileSync(link, '', { flag: 'wx', mode: 0o600 })
  try {
    fs.writeFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    fs.rmSync(link, { force: true })
    throw error
  }
  return publicInfo(record)
}

export function deleteShareLink(token: string) {
  if (!resolveShareToken(token)) return false
  fs.rmSync(shareFile(token), { force: true })
  fs.rmSync(path.join(accountLinks(), token), { force: true })
  return true
}
