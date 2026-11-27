import { useSyncExternalStore, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'
import { getThemeCatalogue, refreshThemeCatalogue, subscribeThemeCatalogue, THEMES, type AppTheme } from '@/lib/theme-palettes'

const queryKey = ['theme-catalogue']
const endpoint = '/api/v1/admin/themes'

function ThemePreview({ theme }: Readonly<{ theme: AppTheme }>) {
  if (theme.wallpaper) {
    return <img src={theme.wallpaper} alt="" loading="lazy" className="h-12 w-20 shrink-0 rounded-md object-cover" />
  }
  return <div aria-hidden="true" className="h-12 w-20 shrink-0 rounded-md bg-slate-950" />
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
  const busy = upload.isPending || changeAvailability.isPending || list.isFetching
  const themes = [...THEMES, ...catalogue.available.filter(theme => theme.id.startsWith('custom-'))]

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
      {(upload.error || changeAvailability.error) && (
        <p role="alert" className="text-sm text-red-400">{(upload.error || changeAvailability.error)?.message}</p>
      )}
      <section className="space-y-2 rounded-xl border border-subtle bg-surface p-4">
        <h2 className="font-semibold">{t('themes.title')}</h2>
        {themes.map(theme => {
          const hidden = catalogue.hidden.includes(theme.id)
          const builtIn = !theme.id.startsWith('custom-')
          const actionLabel = builtIn ? 'themes.remove' : 'action.delete'
          return (
            <div key={theme.id} className="flex items-center gap-3 rounded-lg border border-subtle p-2">
              <ThemePreview theme={theme} />
              <span className="min-w-0 flex-1 break-words text-sm">{theme.name}</span>
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
