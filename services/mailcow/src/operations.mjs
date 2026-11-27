import { fetchFolderMessages, fetchMessageDetail, sendEmailViaSmtp } from './brogaard/mailClient.ts'
import { createContact, createEvent, listContacts, listEvents } from './dav-data.mjs'
import { resolveMailcowAddress } from './network.mjs'

const email = /^[A-Za-z0-9.!#$%&'*+=?^_`{|}~-]+@[A-Za-z0-9.-]+$/
const inbox = 'INBOX'
const operations = new Set(['inbox', 'message', 'send', 'calendar', 'event', 'contacts', 'contact'])

export function hasOperation(name) {
  return operations.has(name)
}

function shortText(value, max) {
  return typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
}

function validArguments(name, input) {
  switch (name) {
    case 'message':
      return Number.isInteger(input.uid) && input.uid >= 1 && input.uid <= 0xffffffff
    case 'send':
      return shortText(input.to, 254) && email.test(input.to) && shortText(input.subject, 255) &&
        typeof input.body === 'string' && input.body.length <= 24_000 && input.body.trim().length > 0
    case 'event':
      return shortText(input.title, 240) && input.title.trim().length > 0 &&
        shortText(input.start, 35) && shortText(input.end, 35) &&
        Number.isFinite(Date.parse(input.start)) && Date.parse(input.start) < Date.parse(input.end)
    case 'contact':
      return shortText(input.name, 240) && input.name.trim().length > 0 &&
        shortText(input.email, 254) && (!input.email || email.test(input.email)) && shortText(input.phone, 100)
    default:
      return true
  }
}

export function createOperations({ smtpPort }) {
  return async (name, account, input = {}) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !validArguments(name, input)) return null
    const address = await resolveMailcowAddress(account.host)
    const creds = {
      imapHost: address, imapServerName: account.host, imapPort: 993, imapSecure: true,
      smtpHost: address, smtpServerName: account.host, smtpPort, smtpSecure: smtpPort === 465,
      username: account.username, password: account.password,
    }
    switch (name) {
      case 'inbox': {
        const { messages } = await fetchFolderMessages(creds, inbox, { limit: 20 })
        return messages.map(({ uid, subject, from, date }) => ({ uid, subject: subject.slice(0, 240), from: from[0]?.address ?? '', date }))
      }
      case 'message': {
        const message = await fetchMessageDetail(creds, inbox, input.uid, false, 2 * 1024 * 1024)
        return { subject: message.subject.slice(0, 240), text: message.textBody.slice(0, 200_000) }
      }
      case 'send':
        await sendEmailViaSmtp(creds, { fromEmail: account.username, to: [input.to], subject: input.subject, textBody: input.body })
        return { ok: true }
      case 'calendar':
        return listEvents(address, account)
      case 'event':
        await createEvent(address, account, input)
        return { ok: true }
      case 'contacts':
        return listContacts(address, account)
      case 'contact':
        await createContact(address, account, input)
        return { ok: true }
      default:
        throw new Error('Unknown Mailcow operation')
    }
  }
}
