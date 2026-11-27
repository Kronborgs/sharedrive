export const pausedMailcowMessage = 'Mailcow afviste login. Opdatér app-adgangskoden under Min Mailcow-konto.'

export class MailcowAuthGate {
  blocked = false
  private pending = Promise.resolve()

  run<T>(operation: () => Promise<T>, loginRejected?: (error: unknown) => boolean): Promise<T> {
    const result = this.pending.then(async () => {
      if (this.blocked) throw new Error(pausedMailcowMessage)
      try {
        return await operation()
      } catch (error) {
        if (loginRejected?.(error)) this.blocked = true
        throw error
      }
    })
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }
}

export function imapLoginRejected(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'authenticationFailed' in error && error.authenticationFailed === true
}

export function smtpLoginRejected(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === 'EAUTH' &&
    'responseCode' in error && error.responseCode === 535
}
