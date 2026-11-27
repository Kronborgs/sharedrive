import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ignorePromise } from '@/lib/ignore-promise'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { mailcowAdminEndpoint, mailcowFeatureKey, type MailcowStatus } from '@/lib/mailcow'

export function MailcowModuleSettings() {
  const { t } = useI18n()
  const client = useQueryClient()
  const [draft, setDraft] = useState<boolean | null>(null)
  const queryKey = ['admin', 'mailcow-module']
  const { data, isError } = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.get<MailcowStatus>(mailcowAdminEndpoint, signal),
    retry: false,
  })
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.put(mailcowAdminEndpoint, { enabled }),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey }),
      client.invalidateQueries({ queryKey: mailcowFeatureKey }),
    ]),
  })

  return (
    <section className="space-y-3 rounded-xl border border-subtle bg-surface p-4">
      <h2 className="font-semibold">{t('mailcowModule.title')}</h2>
      <p className="text-sm text-muted">{t('mailcowModule.description')}</p>
      {isError && <p role="alert" className="text-sm text-red-400">{t('mailcowTest.settingsUnavailable')}</p>}
      {data && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft ?? data.enabled}
            disabled={draft !== null}
            onChange={(event) => {
              const checked = event.currentTarget.checked
              setDraft(checked)
              ignorePromise(save.mutateAsync(checked).catch(() => undefined).finally(() => setDraft(null)))
            }}
          />
          {t('mailcowModule.enable')}
        </label>
      )}
      {save.isError && <p role="alert" className="text-sm text-red-400">{t('settings.saveFailed')}</p>}
      {data?.enabled && !data.ready && <p className="text-sm text-amber-400">{t('mailcowModule.unconfigured')}</p>}
    </section>
  )
}
