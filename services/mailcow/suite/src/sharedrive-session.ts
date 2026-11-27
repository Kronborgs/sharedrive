import type { Request } from 'express'
import type { SuiteSessionPayload } from './services/sessionAuth.js'

export const sessionKey = Symbol('sharedriveMailSession')
type SuiteRequest = Request & { [sessionKey]?: SuiteSessionPayload }

export function getSharedriveSession(req: Request) {
  return (req as SuiteRequest)[sessionKey] ?? null
}

export function setSharedriveSession(req: Request, session: SuiteSessionPayload) {
  ;(req as SuiteRequest)[sessionKey] = session
}
