import { createOperations } from './operations.mjs'
import { createProbe } from './probe.mjs'
import { createProbeServer } from './server.mjs'

const token = process.env.SHAREDRIVE_MAILCOW_TOKEN ?? ''
const port = Number(process.env.SHAREDRIVE_MAILCOW_PORT ?? 3025)
const smtpPort = Number(process.env.SHAREDRIVE_MAILCOW_SMTP_PORT ?? 465)

if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
  throw new Error('Set SHAREDRIVE_MAILCOW_TOKEN to at least 32 URL-safe characters')
}
if (!Number.isInteger(port) || port < 1 || port > 65535 || ![465, 587].includes(smtpPort)) {
  throw new Error('Invalid service port or SMTP port (use 465 or 587)')
}
if (process.env.ALLOW_INSECURE_TLS === 'true' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  throw new Error('Mailcow requires certificate verification')
}

const server = createProbeServer({ token, probe: createProbe({ smtpPort }), operation: createOperations({ smtpPort }) })
server.listen(port, '127.0.0.1', () => {
  console.log(`Sharedrive Mailcow probe listening on 127.0.0.1:${port}`)
})
