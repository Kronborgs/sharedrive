import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import express, { type Request, type Response, type NextFunction } from 'express'
import { Agent } from 'undici'
import { isMailcowHostname, resolveMailcowAddress } from '../../src/network.mjs'
import { suiteContext as binding } from './sharedrive-context.js'
import { setSharedriveSession } from './sharedrive-session.js'
import { mailRouter } from './routes/mail.js'
import { caldavRouter } from './routes/caldav.js'
import { carddavRouter } from './routes/carddav.js'
import { shareOwner } from './services/shareStore.js'
import { getAliasesForUser } from './services/aliasStore.js'

import { MailcowAuthGate, pausedMailcowMessage } from './mailcow-auth.js'

type ProxyAccount = { host: string; username: string; password: string; scope: string; owner: string; credentialRevision?: string }
const checkedLookup = new Agent({
  connect: {
    lookup(host, options, callback) {
      const active = binding.getStore()
      const result = active?.host === host ? Promise.resolve(active.address) : resolveMailcowAddress(host)
      void result.then(address => {
        if (options.all) callback(null, [{ address, family: 4 }])
        else callback(null, address, 4)
      }, error => callback(error, '', 4))
    },
  },
})
const fetchNormally = globalThis.fetch.bind(globalThis)

// The bridge is the only caller of these routes. Pin DAV and all external feed/photo
// connections to public IPv4 addresses, including connections from library code.
globalThis.fetch = (input, init) => {
  const active = binding.getStore()
  if (!active) return fetchNormally(input, init)
  const url = new URL(typeof input === 'object' && 'url' in input ? input.url : input.toString())
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !isMailcowHostname(url.hostname)) {
    return Promise.reject(new Error('External Mailcow requests require HTTPS'))
  }
  const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined))
  if (url.hostname !== active.host && headers.has('authorization')) {
    return Promise.reject(new Error('Mailcow credentials may only be used on the saved provider'))
  }
  const request = () => fetchNormally(input, {
    ...init,
    redirect: init?.redirect === 'manual' ? 'manual' : 'error',
    signal: init?.signal ?? AbortSignal.timeout(20_000),
    dispatcher: checkedLookup,
  } as RequestInit)
  if (url.hostname !== active.host || headers.get('authorization') !== active.authorization) return request()
  return active.authGate.run(async () => {
    const response = await request()
    if (response.status === 401) active.authGate.blocked = true
    return response
  })
}

function fingerprint(value: string) {
  return createHash('sha256').update(value).digest()
}

function readAccount(req: Request): ProxyAccount | null {
  const value = req.get('X-Sharedrive-Mailcow-Account')
  if (!value || value.length > 5000) return null
  try {
    const account = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (typeof account.host !== 'string' || typeof account.username !== 'string' ||
        typeof account.password !== 'string' || !/^[a-f0-9-]{36}$/.test(account.owner) || !/^[a-f0-9]{64}$/.test(account.scope)) return null
    return account
  } catch {
    return null
  }
}

export function createSuiteHandler({ token, smtpPort }: { token: string; smtpPort: number }) {
  const app = express()
  const expected = fingerprint('Bearer ' + token)
  const authGates = new Map<string, MailcowAuthGate>()
  app.disable('x-powered-by')
  app.use(async (req, res, next) => {
    if (!timingSafeEqual(fingerprint(req.get('Authorization') ?? ''), expected)) {
      res.status(401).json({ ok: false, error: 'Sharedrive login required' })
      return
    }
    next()
  })
  app.get('/api/link-owner/:token', (req, res) => {
    const owner = shareOwner(req.params.token)
    if (owner) res.json(owner)
    else res.status(404).json({ ok: false })
  })
  app.use(async (req, res, next) => {
    const account = readAccount(req)
    if (!account) {
      res.status(401).json({ ok: false, error: 'Sharedrive mailbox required' })
      return
    }
    try {
      const address = await resolveMailcowAddress(account.host)
      setSharedriveSession(req, {
        username: account.username, password: account.password, caldavUrl: 'https://' + account.host + '/SOGo/dav/',
        imapHost: address, imapServerName: account.host, imapPort: 993, imapSecure: true,
        smtpHost: address, smtpServerName: account.host, smtpPort, smtpSecure: smtpPort === 465,
      })
      res.locals.account = account
      const revision = account.credentialRevision ?? createHmac('sha256', token).update(account.password).digest('hex')
      const gateKey = account.scope + ':' + revision
      let authGate = authGates.get(gateKey)
      if (!authGate) {
        authGate = new MailcowAuthGate()
        authGates.set(gateKey, authGate)
      }
      const authorization = 'Basic ' + Buffer.from(account.username + ':' + account.password).toString('base64')
      binding.run({ host: account.host, address, scope: account.scope, owner: account.owner, authorization, authGate }, next)
    } catch {
      res.status(502).json({ ok: false, error: 'Mailcow host is unavailable' })
    }
  })
  app.use(express.json({ limit: '25mb' }))
  app.get('/api/auth/config', (_req, res) => {
    res.json({ ok: true, enabledModules: ['mail', 'calendar', 'contacts'], hasDefaultServer: true, sogoUrl: 'https://' + res.locals.account.host + '/SOGo/' })
  })
  app.get('/api/auth/session', (_req, res) => {
    const { username, scope } = res.locals.account as ProxyAccount
    res.json({ ok: true, authenticated: true, username, scope, authBlocked: binding.getStore()?.authGate.blocked, aliases: getAliasesForUser(username, false) })
  })
  app.use(['/api/mail', '/api/caldav', '/api/carddav'], (_req, res, next) => {
    if (binding.getStore()?.authGate.blocked) {
      res.status(424).json({ ok: false, error: pausedMailcowMessage })
      return
    }
    next()
  })
  app.use('/api/mail', mailRouter)
  app.use('/api/caldav', caldavRouter)
  app.use('/api/carddav', carddavRouter)
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'Unknown Mailcow operation' }))
  app.use((err: { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status === 413 ? 413 : 502).json({ ok: false, error: 'Mailcow request failed' })
  })
  return app
}
