import { useState, useSyncExternalStore, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'
import { getThemeCatalogue, refreshThemeCatalogue, subscribeThemeCatalogue, type AppTheme } from '@/lib/theme-palettes'

const queryKey = ['theme-catalogue']
const endpoint = '/api/v1/admin/themes'

function ThemePreview({ theme }: Readonly<{ theme: AppTheme }>) {
  if (theme.wallpaper) {
    return <img src={theme.wallpaper} alt="" loading="lazy" className="h-12 w-20 shrink-0 rounded-md object-cover" />
  }
  return <div aria-hidden="true" className="h-12 w-20 shrink-0 rounded-md bg-slate-950" />
}

type ThemeColors = { accent: string; background: string; panel: string }

function colorToHex(value: string): string {
  if (/^#[a-f0-9]{6}$/i.test(value)) return value
  const parts = value.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/i)
  return parts ? '#' + parts.slice(1, 4).map(part => Number(part).toString(16).padStart(2, '0')).join('') : '#000000'
}

function ThemeColorEditor({ theme, disabled, onSave }: Readonly<{ theme: AppTheme; disabled: boolean; onSave: (id: string, colors: ThemeColors) => void }>) {
  const { t } = useI18n()
  const original = { accent: colorToHex(theme.accent), background: colorToHex(theme.gridBg), panel: colorToHex(theme.surface) }
  const [colors, setColors] = useState(original)
  const fields = [
    { key: 'accent' as const, label: t('themes.accent') },
    { key: 'background' as const, label: t('themes.backgroundColor') },
    { key: 'panel' as const, label: t('themes.panelColor') },
  ]
  return (
    <div className="flex flex-wrap items-end gap-2">
      {fields.map(field => (
        <label key={field.key} className="flex flex-col gap-1 text-xs text-muted">
          {field.label}
          <input type="color" value={colors[field.key]} onChange={event => setColors({ ...colors, [field.key]: event.target.value })} aria-label={t('themes.colorNamed', { color: field.label, name: theme.name })} disabled={disabled} />
        </label>
      ))}
      <button type="button" disabled={disabled || fields.every(field => colors[field.key].toLowerCase() === original[field.key].toLowerCase())} onClick={() => onSave(theme.id, colors)} className="rounded-md border border-subtle px-2 py-1 text-xs disabled:opacity-50">{t('themes.saveColors')}</button>
    </div>
  )
}
export function ThemeSettings() {
  const { t } = useI18n()
  const qc = useQueryClient()
  const catalogue = useSyncExternalStore(subscribeThemeCatalogue, getThemeCatalogue)
  const list = useQuery({ queryKey, queryFn: refreshThemeCatalogue, retry: false })
  const refresh = () => ignorePromise(qc.invalidateQueries({ queryKey }))
  const upload = useMutation({
    mutationFn: (data: FormData) => api.post(endpoint, data),
    onSuccess: refresh,
  })
  const changeAvailability = useMutation({
    mutationFn: ({ id, restore }: { id: string; restore: boolean }) => {
      const path = endpoint + '/' + encodeURIComponent(id)
      return restore ? api.put(path + '/restore', {}) : api.delete(path)
    },
    onSuccess: refresh,
  })
  const changeAccent = useMutation({
    mutationFn: ({ id, colors }: { id: string; colors: ThemeColors }) => api.put(endpoint + '/' + encodeURIComponent(id) + '/accent', colors),
    onSuccess: refresh,
  })
  const busy = upload.isPending || changeAvailability.isPending || changeAccent.isPending || list.isFetching
  const themes = catalogue.all

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    upload.mutate(new FormData(form), { onSuccess: () => form.reset() })
  }

  function remove(theme: AppTheme) {
    if (theme.id.startsWith('custom-') && !window.confirm(t('themes.confirmDelete', { name: theme.name }))) return
    changeAvailability.mutate({ id: theme.id, restore: false })
  }

  return (
    <div className="max-w-2xl space-y-5">
      <form onSubmit={submit} className="space-y-3 rounded-xl border border-subtle bg-surface p-4">
        <h2 className="font-semibold">{t('themes.upload')}</h2>
        <p className="text-sm text-muted">{t('themes.uploadHelp')}</p>
        <label className="block space-y-1 text-sm">
          <span>{t('themes.name')}</span>
          <input name="name" required maxLength={60} className="w-full rounded-md border border-subtle bg-(--app-bg) px-3 py-2" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span>{t('themes.accent')}</span>
          <input type="color" name="accent" defaultValue="#4776ad" />
        </label>
        <label className="block space-y-1 text-sm">
          <span>{t('themes.background')}</span>
          <input type="file" name="image" accept="image/jpeg,image/png,image/webp" required className="block max-w-full text-sm" />
        </label>
        <button type="submit" disabled={busy || list.isError} className="rounded-md bg-brand-600 px-3 py-2 text-sm text-white disabled:opacity-50">
          {t('themes.upload')}
        </button>
      </form>
      {list.isError && <p role="alert" className="text-sm text-red-400">{t('themes.unavailable')}</p>}
      {(upload.error || changeAvailability.error || changeAccent.error) && (
        <p role="alert" className="text-sm text-red-400">{(upload.error || changeAvailability.error || changeAccent.error)?.message}</p>
      )}
      <section className="space-y-2 rounded-xl border border-subtle bg-surface p-4">
        <h2 className="font-semibold">{t('themes.title')}</h2>
        {themes.map(theme => {
          const hidden = catalogue.hidden.includes(theme.id)
          const builtIn = !theme.id.startsWith('custom-')
          const actionLabel = builtIn ? 'themes.remove' : 'action.delete'
          return (
            <div key={theme.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-subtle p-2">
              <ThemePreview theme={theme} />
              <span className="min-w-0 flex-1 break-words text-sm">{theme.name}</span>
              <ThemeColorEditor key={theme.id + theme.accent + theme.gridBg + theme.surface} theme={theme} disabled={busy || list.isError} onSave={(id, colors) => changeAccent.mutate({ id, colors })} />
              {theme.id === 'classic-dark' && <span className="text-xs text-muted">{t('themes.fallback')}</span>}
              {theme.id !== 'classic-dark' && (
                <button type="button" disabled={busy || list.isError}
                  aria-label={t(hidden ? 'themes.restoreNamed' : 'themes.removeNamed', { name: theme.name })}
                  onClick={() => hidden ? changeAvailability.mutate({ id: theme.id, restore: true }) : remove(theme)}
                  className="shrink-0 rounded-md border border-subtle px-2 py-1 text-xs disabled:opacity-50">
                  {t(hidden ? 'themes.restore' : actionLabel)}
                </button>
              )}
            </div>
          )
        })}
      </section>
    </div>
  )
}
