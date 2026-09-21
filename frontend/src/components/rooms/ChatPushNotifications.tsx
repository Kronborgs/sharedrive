import { useEffect, useState } from 'react'
import { Bell, BellOff, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

interface PushConfig { enabled: boolean; public_key?: string }
interface SerializedSubscription {
  endpoint: string
  keys?: { p256dh?: string; auth?: string }
}

function applicationServerKey(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
  return bytes.buffer
}

export async function unregisterRoomPushSubscription(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return
  await api.deleteWithBody('/api/v1/rooms/push-subscriptions', { endpoint: subscription.endpoint })
  await subscription.unsubscribe()
}

export function ChatPushNotifications() {
  const { t, locale } = useI18n()
  const [config, setConfig] = useState<PushConfig | null>(null)
  const [supported, setSupported] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    let cancelled = false
    const supportedHere = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
    setSupported(supportedHere)
    if (!supportedHere) { setBusy(false); return }
    void (async () => {
      try {
        const serverConfig = await api.get<PushConfig>('/api/v1/rooms/push-config')
        if (cancelled) return
        setConfig(serverConfig)
        if (!serverConfig.enabled) return
        const registration = await navigator.serviceWorker.ready
        const existing = await registration.pushManager.getSubscription()
        if (cancelled) return
        setSubscribed(Boolean(existing))
        if (existing) {
          const saved = existing.toJSON() as SerializedSubscription
          if (saved.keys?.p256dh && saved.keys.auth) {
            await api.post('/api/v1/rooms/push-subscriptions', { ...saved, locale })
          }
        }
      } catch {
        if (!cancelled) setConfig({ enabled: false })
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => { cancelled = true }
  }, [locale])

  const toggle = async () => {
    if (!config?.enabled || !config.public_key || busy) return
    setBusy(true)
    try {
      const registration = await navigator.serviceWorker.ready
      const current = await registration.pushManager.getSubscription()
      if (current) {
        await api.deleteWithBody('/api/v1/rooms/push-subscriptions', { endpoint: current.endpoint })
        await current.unsubscribe()
        setSubscribed(false)
        toast.success(t('rooms.pushDisabled'))
        return
      }

      const permission = Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission
      if (permission !== 'granted') {
        toast.error(t('rooms.pushPermissionDenied'))
        return
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(config.public_key),
      })
      const serialized = subscription.toJSON() as SerializedSubscription
      if (!serialized.keys?.p256dh || !serialized.keys.auth) {
        await subscription.unsubscribe()
        throw new Error('Push subscription is missing encryption keys.')
      }
      await api.post('/api/v1/rooms/push-subscriptions', { ...serialized, locale })
      setSubscribed(true)
      toast.success(t('rooms.pushEnabled'))
    } catch {
      toast.error(t('rooms.pushFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (!supported) return null
  if (config && !config.enabled) return <p className="px-2 py-2 text-xs text-muted">{t('rooms.pushUnavailable')}</p>

  return <button type="button" onClick={() => { void toggle() }} disabled={busy || !config?.enabled} aria-pressed={subscribed} className="mt-2 flex min-h-10 w-full items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-left text-xs font-medium text-muted hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-60 dark:hover:bg-[#2d3148] dark:hover:text-slate-100">
    {busy ? <Loader2 size={15} className="animate-spin" /> : subscribed ? <BellOff size={15} /> : <Bell size={15} />}
    <span>{subscribed ? t('rooms.pushDisable') : t('rooms.pushEnable')}</span>
  </button>
}