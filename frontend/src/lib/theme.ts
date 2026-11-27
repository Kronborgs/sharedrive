const STORAGE_KEY = 'sharedrive-theme'

export type Theme = 'dark' | 'nordic-blue-hour'

const DEFAULT_THEME: Theme = 'nordic-blue-hour'

let activeTheme: Theme = DEFAULT_THEME

export function getActiveTheme(): Theme {
  return activeTheme
}

function getStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'nordic-blue-hour') return stored
  } catch {
    // localStorage unavailable
  }
  return null
}

export function applyTheme(theme: Theme) {
  activeTheme = theme
  const root = document.documentElement
  root.classList.add('dark')
  root.dataset.theme = theme
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // ignore
  }
}

// Call once on app load before first render to prevent flash
export function initTheme() {
  applyTheme(getStoredTheme() ?? DEFAULT_THEME)
}
