import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { setDatabaseScope } from './db/database'
import { setStorageScope } from './sharedrive-storage'
import './style.css'

async function accountScope(): Promise<string> {
  const share = new URLSearchParams(window.location.search).get('share')
  if (share && /^[a-zA-Z0-9_-]{24}$/.test(share)) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('public-calendar:' + share))
    return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('')
  }
  const answer = await fetch('/api/v1/me/mailcow/suite/auth/session', { credentials: 'same-origin', cache: 'no-store' })
  if (!answer.ok) throw new Error('Sharedrive Mail is unavailable')
  const session = await answer.json()
  if (!session.authenticated || !session.scope) throw new Error('Mailcow account required')
  return session.scope
}

async function start() {
  const scope = await accountScope()
  setStorageScope(scope)
  setDatabaseScope(scope)
  const app = createApp(App)
  app.use(createPinia())
  app.mount('#app')
  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {})
  }
}

void start().catch(() => {
  const root = document.getElementById('app')
  if (root) root.textContent = navigator.onLine
    ? 'Mail kunne ikke åbnes. Kontrollér din konto i Sharedrive.'
    : 'Forbind til internettet for at åbne Mail og bekræfte din Sharedrive-session.'
})
