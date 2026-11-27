import { checkSogo } from './dav-probe.mjs'
import nodemailer from 'nodemailer'
import { fetchMailFolders } from './brogaard/mailClient.ts'
import { resolveMailcowAddress } from './network.mjs'

async function check(operation) {
  try {
    await operation()
    return 'ok'
  } catch {
    return 'failed'
  }
}

async function checkSmtp(mail, servername) {
  const transport = nodemailer.createTransport({
    host: mail.smtpHost,
    port: mail.smtpPort,
    secure: mail.smtpSecure,
    requireTLS: !mail.smtpSecure,
    tls: { rejectUnauthorized: true, servername },
    auth: { user: mail.username, pass: mail.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  })
  try {
    await transport.verify()
  } finally {
    transport.close()
  }
}

export function createProbe({ smtpPort }) {
  return async (account) => {
    let address
    try {
      address = await resolveMailcowAddress(account.host)
    } catch {
      return { imap: 'failed', smtp: 'failed', caldav: 'failed', carddav: 'failed' }
    }

    const mail = {
      username: account.username,
      password: account.password,
      imapHost: address,
      imapServerName: account.host,
      imapPort: 993,
      imapSecure: true,
      smtpHost: address,
      smtpPort,
      smtpSecure: smtpPort === 465,
    }
    const [imap, smtp, caldav, carddav] = await Promise.all([
      check(() => fetchMailFolders(mail)),
      check(() => checkSmtp(mail, account.host)),
      check(() => checkSogo(address, account, 'Calendar')),
      check(() => checkSogo(address, account, 'Contacts')),
    ])
    return { imap, smtp, caldav, carddav }
  }
}
