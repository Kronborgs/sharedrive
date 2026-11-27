import { ref, computed } from 'vue';
import { getTheme, readTheme, saveTheme, refreshThemeCatalogue, getThemeCatalogue, subscribeThemeCatalogue, themeStorageKey, type AppTheme, type ThemeId } from '../../../src/lib/theme-palettes';

export type { ThemeId } from '../../../src/lib/theme-palettes';


const activeThemeId = ref<ThemeId>(readTheme().id);
const themes = ref(getThemeCatalogue().available);
function applyThemeToDocument(theme: AppTheme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.dataset.hasWallpaper = theme.wallpaper ? 'true' : 'false';
  root.style.setProperty('--theme-accent', theme.accent);
  root.style.setProperty('--theme-accent-hover', theme.accentHover);
  root.style.setProperty('--theme-accent-text', theme.accentText);
  root.style.setProperty('--theme-accent-soft', theme.accentSoft);
  root.style.setProperty('--theme-surface', theme.surface);
  root.style.setProperty('--theme-grid-bg', theme.gridBg);
  root.style.setProperty('--theme-login-card', theme.loginCard);
  root.style.setProperty('--theme-border', theme.border);
  root.style.setProperty('--theme-login-overlay', theme.loginOverlay);
  root.style.setProperty('--theme-app-overlay', theme.appOverlay);
}

function syncTheme() {
  const current = readTheme();
  activeThemeId.value = current.id;
  applyThemeToDocument(current);
}

syncTheme();
subscribeThemeCatalogue(() => {
  themes.value = getThemeCatalogue().available;
  syncTheme();
});
window.addEventListener('storage', event => {
  if (event.key === themeStorageKey || event.key === null) syncTheme();
});

function refreshThemes() {
  void refreshThemeCatalogue().catch(() => {});
}
window.addEventListener('focus', refreshThemes);
refreshThemes();

export function useTheme() {
  const currentTheme = computed<AppTheme>(
    () => themes.value.find(theme => theme.id === activeThemeId.value) ?? themes.value[0]
  );

  function setTheme(id: ThemeId) {
    const target = getTheme(id);
    if (!target) return;
    activeThemeId.value = id;
    saveTheme(id);
    applyThemeToDocument(target);
  }

  return {
    themes,
    activeThemeId,
    currentTheme,
    setTheme
  };
}
