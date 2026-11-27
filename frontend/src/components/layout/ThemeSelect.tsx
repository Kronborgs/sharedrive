import { useState, useSyncExternalStore } from 'react'
import { useI18n } from '@/lib/i18n'
import { getThemeCatalogue, subscribeThemeCatalogue, type AppTheme } from '@/lib/theme-palettes'
import { applyTheme, getActiveTheme, themeValue } from '@/lib/theme'

export function ThemeSelect() {
  const { t } = useI18n()
  const [, rerender] = useState(0)
  const catalogue = useSyncExternalStore(subscribeThemeCatalogue, getThemeCatalogue)

  function label(theme: AppTheme) {
    if (theme.id === 'nordic-blue-hour') return t('theme.nordicBlueHour')
    if (theme.id === 'classic-dark') return t('theme.classicDark')
    return theme.name
  }

  return (
    <select
      aria-label={t('theme.label')}
      className="min-w-0 max-w-40 shrink rounded-xl border border-subtle bg-surface px-3 py-2 text-xs font-medium shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 sm:max-w-none sm:text-sm"
      value={getActiveTheme()}
      onChange={(event) => {
        const value = event.currentTarget.value
        applyTheme(value)
        rerender(value => value + 1)
      }}
    >
      {catalogue.available.map(palette => <option key={palette.id} value={themeValue(palette.id)}>{label(palette)}</option>)}
    </select>
  )
}
