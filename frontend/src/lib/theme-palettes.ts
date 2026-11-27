export type ThemeId =
  | 'nordic-blue-hour'
  | 'vesterhavet'
  | 'nordic-forest'
  | 'arctic-night'
  | 'neon-80s'
  | 'cyberpunk-city'
  | 'vice-sunset'
  | 'dark-3d-glass'
  | 'retro-supercar'
  | 'deep-space-3d'
  | 'classic-dark'
  | `custom-${string}`;

export interface AppTheme {
  id: ThemeId;
  name: string;
  subtitle: string;
  wallpaper: string | null;
  swatch: string;
  accent: string;
  accentHover: string;
  accentText: string;
  accentSoft: string;
  surface: string;
  gridBg: string;
  loginCard: string;
  border: string;
  loginOverlay: string;
  appOverlay: string;
}

export const THEMES: AppTheme[] = [
  {
    id: 'nordic-blue-hour',
    name: 'Nordisk Blå Time',
    subtitle: 'Fjord i blå time',
    wallpaper: '/themes/nordic-blue-hour.jpg',
    swatch: '#4776ad',
    accent: '#4776ad',
    accentHover: '#5787bf',
    accentText: '#ffffff',
    accentSoft: 'rgba(71, 118, 173, 0.24)',
    surface: 'rgba(10, 17, 30, 0.72)',
    gridBg: 'rgba(8, 14, 26, 0.76)',
    loginCard: 'rgba(12, 19, 32, 0.30)',
    border: 'rgba(255, 255, 255, 0.12)',
    loginOverlay: 'linear-gradient(180deg, rgba(6, 12, 24, 0.18) 0%, rgba(6, 12, 24, 0.40) 100%)',
    appOverlay: 'rgba(6, 11, 22, 0.42)'
  },
  {
    id: 'vesterhavet',
    name: 'Vesterhavet i Skumring',
    subtitle: 'Klitter & varm horisont',
    wallpaper: '/themes/vesterhavet.jpg',
    swatch: '#d19a66',
    accent: '#d19a66',
    accentHover: '#dca978',
    accentText: '#121318',
    accentSoft: 'rgba(209, 154, 102, 0.22)',
    surface: 'rgba(18, 17, 22, 0.76)',
    gridBg: 'rgba(14, 14, 18, 0.80)',
    loginCard: 'rgba(20, 19, 24, 0.32)',
    border: 'rgba(255, 240, 220, 0.13)',
    loginOverlay: 'linear-gradient(180deg, rgba(12, 11, 16, 0.20) 0%, rgba(12, 11, 16, 0.44) 100%)',
    appOverlay: 'rgba(12, 11, 16, 0.48)'
  },
  {
    id: 'nordic-forest',
    name: 'Nordisk Skov',
    subtitle: 'Granskov i morgentåge',
    wallpaper: '/themes/nordic-forest.jpg',
    swatch: '#2f705e',
    accent: '#2f705e',
    accentHover: '#3b8571',
    accentText: '#ffffff',
    accentSoft: 'rgba(47, 112, 94, 0.25)',
    surface: 'rgba(11, 19, 17, 0.74)',
    gridBg: 'rgba(8, 15, 14, 0.78)',
    loginCard: 'rgba(13, 21, 19, 0.31)',
    border: 'rgba(220, 255, 242, 0.12)',
    loginOverlay: 'linear-gradient(180deg, rgba(7, 14, 12, 0.18) 0%, rgba(7, 14, 12, 0.42) 100%)',
    appOverlay: 'rgba(7, 14, 12, 0.46)'
  },
  {
    id: 'arctic-night',
    name: 'Arktisk Nat',
    subtitle: 'Fjeldsø & diskret nordlys',
    wallpaper: '/themes/arctic-night.jpg',
    swatch: '#2d7482',
    accent: '#2d7482',
    accentHover: '#388999',
    accentText: '#ffffff',
    accentSoft: 'rgba(45, 116, 130, 0.25)',
    surface: 'rgba(9, 15, 24, 0.74)',
    gridBg: 'rgba(7, 12, 20, 0.78)',
    loginCard: 'rgba(10, 16, 26, 0.30)',
    border: 'rgba(210, 245, 255, 0.12)',
    loginOverlay: 'linear-gradient(180deg, rgba(5, 9, 18, 0.16) 0%, rgba(5, 9, 18, 0.38) 100%)',
    appOverlay: 'rgba(5, 9, 18, 0.42)'
  },
  {
    id: 'neon-80s',
    name: "80'er Neon",
    subtitle: 'Synthwave & retro-gitter',
    wallpaper: '/themes/neon-80s.svg',
    swatch: '#ec1c9c',
    accent: '#e11d91',
    accentHover: '#f43fb0',
    accentText: '#ffffff',
    accentSoft: 'rgba(236, 28, 156, 0.22)',
    surface: 'rgba(13, 8, 28, 0.76)',
    gridBg: 'rgba(9, 5, 22, 0.78)',
    loginCard: 'rgba(14, 8, 30, 0.34)',
    border: 'rgba(34, 211, 238, 0.28)',
    loginOverlay: 'linear-gradient(180deg, rgba(8, 3, 22, 0.14) 0%, rgba(8, 3, 22, 0.34) 100%)',
    appOverlay: 'rgba(7, 3, 20, 0.36)'
  },
  {
    id: 'cyberpunk-city',
    name: '3D Cyberpunk-by',
    subtitle: 'Neonlys & fremtidsby',
    wallpaper: '/themes/cyberpunk-city.jpg',
    swatch: '#06b6d4',
    accent: '#0891b2',
    accentHover: '#06b6d4',
    accentText: '#ffffff',
    accentSoft: 'rgba(6, 182, 212, 0.22)',
    surface: 'rgba(8, 15, 26, 0.74)',
    gridBg: 'rgba(6, 12, 22, 0.78)',
    loginCard: 'rgba(8, 16, 28, 0.32)',
    border: 'rgba(34, 211, 238, 0.28)',
    loginOverlay: 'linear-gradient(180deg, rgba(4, 10, 20, 0.16) 0%, rgba(4, 10, 20, 0.40) 100%)',
    appOverlay: 'rgba(4, 10, 20, 0.40)'
  },
  {
    id: 'vice-sunset',
    name: 'Vice City Skumring',
    subtitle: '3D palmer & neon-solnedgang',
    wallpaper: '/themes/vice-sunset.jpg',
    swatch: '#fb7185',
    accent: '#e11d48',
    accentHover: '#f43f5e',
    accentText: '#ffffff',
    accentSoft: 'rgba(244, 63, 94, 0.22)',
    surface: 'rgba(20, 11, 24, 0.76)',
    gridBg: 'rgba(15, 8, 20, 0.80)',
    loginCard: 'rgba(22, 12, 26, 0.34)',
    border: 'rgba(251, 113, 133, 0.28)',
    loginOverlay: 'linear-gradient(180deg, rgba(16, 8, 22, 0.22) 0%, rgba(16, 8, 22, 0.44) 100%)',
    appOverlay: 'rgba(14, 7, 20, 0.48)'
  },
  {
    id: 'dark-3d-glass',
    name: 'Mørkt 3D-glas',
    subtitle: 'Abstrakt 3D-glas & lys',
    wallpaper: '/themes/dark-3d-glass.jpg',
    swatch: '#818cf8',
    accent: '#4f46e5',
    accentHover: '#6366f1',
    accentText: '#ffffff',
    accentSoft: 'rgba(99, 102, 241, 0.24)',
    surface: 'rgba(12, 14, 26, 0.74)',
    gridBg: 'rgba(9, 11, 22, 0.78)',
    loginCard: 'rgba(14, 16, 30, 0.30)',
    border: 'rgba(165, 180, 252, 0.20)',
    loginOverlay: 'linear-gradient(180deg, rgba(8, 10, 22, 0.16) 0%, rgba(8, 10, 22, 0.38) 100%)',
    appOverlay: 'rgba(8, 10, 22, 0.38)'
  },
  {
    id: 'retro-supercar',
    name: 'Retro 3D-sportsvogn',
    subtitle: "80'er superbil i neonnat",
    wallpaper: '/themes/retro-supercar.jpg',
    swatch: '#ef4444',
    accent: '#dc2626',
    accentHover: '#ef4444',
    accentText: '#ffffff',
    accentSoft: 'rgba(239, 68, 68, 0.22)',
    surface: 'rgba(10, 14, 18, 0.75)',
    gridBg: 'rgba(7, 10, 14, 0.79)',
    loginCard: 'rgba(12, 15, 20, 0.32)',
    border: 'rgba(248, 113, 113, 0.25)',
    loginOverlay: 'linear-gradient(180deg, rgba(5, 8, 12, 0.16) 0%, rgba(5, 8, 12, 0.40) 100%)',
    appOverlay: 'rgba(5, 8, 12, 0.40)'
  },
  {
    id: 'deep-space-3d',
    name: '3D Rummet',
    subtitle: 'Planeter & kosmisk tåge',
    wallpaper: '/themes/deep-space-3d.jpg',
    swatch: '#f97316',
    accent: '#ea580c',
    accentHover: '#f97316',
    accentText: '#ffffff',
    accentSoft: 'rgba(249, 115, 22, 0.22)',
    surface: 'rgba(6, 11, 20, 0.74)',
    gridBg: 'rgba(5, 9, 17, 0.78)',
    loginCard: 'rgba(8, 13, 24, 0.28)',
    border: 'rgba(125, 211, 252, 0.18)',
    loginOverlay: 'linear-gradient(180deg, rgba(3, 6, 14, 0.16) 0%, rgba(3, 6, 14, 0.36) 100%)',
    appOverlay: 'rgba(3, 6, 14, 0.36)'
  },
  {
    id: 'classic-dark',
    name: 'Klassisk Mørk',
    subtitle: 'Ren mørk uden baggrund',
    wallpaper: null,
    swatch: '#2563eb',
    accent: '#2563eb',
    accentHover: '#3b82f6',
    accentText: '#ffffff',
    accentSoft: 'rgba(37, 99, 235, 0.22)',
    surface: 'rgba(15, 23, 42, 0.96)',
    gridBg: 'rgba(2, 6, 23, 0.96)',
    loginCard: 'rgba(15, 23, 42, 0.90)',
    border: '#1e293b',
    loginOverlay: 'radial-gradient(circle at 50% 40%, rgba(30, 58, 138, 0.18), rgba(2, 6, 23, 0.98))',
    appOverlay: 'rgba(2, 6, 23, 1)'
  }
];

export const themeStorageKey = 'sharedrive-theme'

type ThemeCatalogue = { available: AppTheme[]; hidden: string[] }
let catalogue: ThemeCatalogue = { available: THEMES, hidden: [] }
const catalogueListeners = new Set<() => void>()
let refreshVersion = 0

export function getThemeCatalogue() {
  return catalogue
}

export function subscribeThemeCatalogue(listener: () => void) {
  catalogueListeners.add(listener)
  return () => { catalogueListeners.delete(listener) }
}

type UploadedTheme = { id: string; name: string; accent: string }
export async function refreshThemeCatalogue() {
  const version = ++refreshVersion
  const response = await fetch('/api/v1/themes', { cache: 'no-store' })
  if (!response.ok) throw new Error('Theme catalogue is unavailable')
  const { data } = await response.json()
  if (!data || !Array.isArray(data.hidden) || !Array.isArray(data.uploaded)) {
    throw new Error('Invalid theme catalogue')
  }
  const hidden: string[] = data.hidden
  const hiddenIds = new Set(hidden)
  const uploaded: AppTheme[] = (data.uploaded as UploadedTheme[]).flatMap(theme => {
    if (!/^custom-[a-f0-9-]{36}$/.test(theme.id) || !/^#[a-f0-9]{6}$/i.test(theme.accent)) return []
    return [{
      ...THEMES[0],
      id: theme.id as ThemeId,
      name: theme.name,
      subtitle: '',
      wallpaper: '/api/v1/themes/' + theme.id + '/image',
      swatch: theme.accent,
      accent: theme.accent,
      accentHover: theme.accent,
      accentSoft: theme.accent + '3d',
    }]
  })
  if (version !== refreshVersion) return catalogue
  catalogue = { available: [...THEMES.filter(theme => theme.id === 'classic-dark' || !hiddenIds.has(theme.id)), ...uploaded], hidden }
  for (const listener of catalogueListeners) listener()
  return catalogue
}


export function getTheme(id: string | null): AppTheme | undefined {
  return catalogue.available.find(theme => theme.id === (id === 'dark' ? 'classic-dark' : id))
}

export function readTheme(): AppTheme {
  try {
    const stored = localStorage.getItem(themeStorageKey) ?? localStorage.getItem('sharedrive-mail-theme-v1')
    return getTheme(stored) ?? catalogue.available[0]
  } catch {
    return catalogue.available[0]
  }
}

export function saveTheme(id: ThemeId) {
  try {
    localStorage.setItem(themeStorageKey, id === 'classic-dark' ? 'dark' : id)
  } catch {
    // The chosen theme still applies to the current page.
  }
}
