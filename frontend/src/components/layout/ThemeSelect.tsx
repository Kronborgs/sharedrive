import { useState } from 'react'
import { useI18n } from '@/lib/i18n'
import { applyTheme, getActiveTheme } from '@/lib/theme'

export function ThemeSelect() {
  const { t } = useI18n()
  const [theme, setTheme] = useState(getActiveTheme)

  return (
    <select
      aria-label={t('theme.label')}
      className="min-w-0 max-w-40 shrink rounded-xl border border-subtle bg-surface px-3 py-2 text-xs font-medium shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 sm:max-w-none sm:text-sm"
      value={theme}
      onChange={(event) => {
        const value = event.currentTarget.value
        if (value === 'dark' || value === 'nordic-blue-hour') {
          applyTheme(value)
          setTheme(value)
        }
      }}
    >
      <option value="nordic-blue-hour">{t('theme.nordicBlueHour')}</option>
      <option value="dark">{t('theme.classicDark')}</option>
    </select>
  )
}
