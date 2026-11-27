import type { Request, Response, NextFunction } from 'express'
import { isIP } from 'node:net'
import { getSharedriveSession } from '../sharedrive-session.js'
import type { MailServerCredentials } from './mailClient.js'
import type { CalDavCredentials } from './davClient.js'

export interface SuiteSessionPayload extends MailServerCredentials {
  caldavUrl: string
}

function clientIp(req: Request): string | undefined {
  const address = req.get('X-Sharedrive-Client-IP')
  return address && isIP(address) ? address : undefined
}

export function createRateLimiter(maxHits: number, windowMs: number, errorMessage: string) {
  const hits = new Map<string, { count: number; resetAt: number }>()
  let cleanAt = 0

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = clientIp(req) ?? req.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    if (now >= cleanAt) {
      for (const [key, record] of hits) {
        if (record.resetAt <= now) hits.delete(key)
      }
      cleanAt = now + windowMs
    }
    let record = hits.get(ip)
    if (!record || record.resetAt <= now) {
      record = { count: 0, resetAt: now + windowMs }
      hits.set(ip, record)
    }
    if (++record.count > maxHits) {
      res.status(429).json({ ok: false, error: errorMessage })
      return
    }
    next()
  }
}

export function requireMailCredentials(req: Request): MailServerCredentials {
  const session = getSharedriveSession(req)
  if (!session) throw new Error('Mailcow-kontoen er ikke tilknyttet.')
  const { caldavUrl, ...credentials } = session
  return { ...credentials, clientIp: clientIp(req) }
}

export function requireDavCredentials(req: Request): CalDavCredentials {
  const session = getSharedriveSession(req)
  if (!session) throw new Error('Mailcow-kontoen er ikke tilknyttet.')
  return {
    serverUrl: session.caldavUrl,
    username: session.username,
    password: session.password,
    clientIp: clientIp(req),
  }
}
