export const offlineMailKey = 'sharedrive-offline-mail-v1'
export const offlineMailResetKey = 'sharedrive-offline-mail-reset'

export function clearOfflineMail() {
  try {
    localStorage.removeItem(offlineMailKey)
    localStorage.setItem(offlineMailResetKey, crypto.randomUUID())
  } catch {
    // Storage can be disabled by the browser.
  }
}
