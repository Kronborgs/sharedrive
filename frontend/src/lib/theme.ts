import { getTheme, readTheme, refreshThemeCatalogue, saveTheme, subscribeThemeCatalogue, type AppTheme, type ThemeId } from './theme-palettes'

export type Theme = Exclude<ThemeId, 'classic-dark'> | 'dark'

export function themeValue(id: ThemeId): Theme {
  return id === 'classic-dark' ? 'dark' : id
}

let activeTheme: Theme = 'nordic-blue-hour'

export function getActiveTheme(): Theme {
  return activeTheme
}

function renderTheme(theme: AppTheme) {
  activeTheme = themeValue(theme.id)
  const root = document.documentElement
  root.classList.add('dark')
  root.dataset.theme = activeTheme
  if (theme.wallpaper) {
    const wallpaper = `url("${theme.wallpaper}")`
    root.style.setProperty('--shared-login-wallpaper', `${theme.loginOverlay}, ${wallpaper}`)
    root.style.setProperty('--shared-app-wallpaper', `linear-gradient(${theme.appOverlay}, ${theme.appOverlay}), ${wallpaper}`)
    root.style.setProperty('--shared-theme-bg', theme.gridBg)
    root.style.setProperty('--shared-theme-surface', theme.surface)
    root.style.setProperty('--shared-theme-border', theme.border)
    root.style.setProperty('--shared-theme-accent', theme.accent)
    root.style.setProperty('--shared-theme-accent-hover', theme.accentHover)
  }
}

export function applyTheme(value: string) {
  const theme = getTheme(value)
  if (!theme) return
  renderTheme(theme)
  saveTheme(theme.id)
}

export function initTheme() {
  const sync = () => { void refreshThemeCatalogue().catch(() => {}) }
  renderTheme(readTheme())
  subscribeThemeCatalogue(() => renderTheme(readTheme()))
  window.addEventListener('focus', sync)
  sync()
}
