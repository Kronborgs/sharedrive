const STORAGE_KEY = 'privatedrive-theme'

export type Theme = 'dark'

export function getStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark') return stored
  } catch {
    // localStorage unavailable
  }
  return null
}

export function getSystemTheme(): Theme {
  return 'dark'
}

export function applyTheme(_theme: Theme = 'dark') {
  const root = document.documentElement
  root.classList.add('dark')
  try {
    localStorage.setItem(STORAGE_KEY, 'dark')
  } catch {
    // ignore
  }
}

// Call once on app load before first render to prevent flash
export function initTheme() {
  applyTheme()
  return 'dark' as const
}
