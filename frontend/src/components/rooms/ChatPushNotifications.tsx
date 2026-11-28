import { useEffect, useState } from 'react'
import { Bell, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

interface PushConfig { enabled: boolean; public_key?: string }
interface SerializedSubscription {
  endpoint: string
  keys?: { p256dh?: string; auth?: string }
}

function supportsPushNotifications(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

function applicationServerKey(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = (decoded.codePointAt(index) ?? 0)
  return bytes.buffer
}

async function saveSubscription(subscription: PushSubscription, locale: string): Promise<void> {
  const serialized = subscription.toJSON() as SerializedSubscription
  if (!serialized.keys?.p256dh || !serialized.keys.auth) {
    throw new Error('Push subscription is missing encryption keys.')
  }
  await api.post('/api/v1/rooms/push-subscriptions', { ...serialized, locale })
}

async function readyServiceWorker(): Promise<ServiceWorkerRegistration> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Service worker is not ready.')), 10000) }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function subscribeRoomPush(config: PushConfig, locale: string): Promise<boolean> {
  if (!config.enabled || !config.public_key || !supportsPushNotifications() || Notification.permission !== 'granted') return false
  const registration = await readyServiceWorker()
  const existing = await registration.pushManager.getSubscription()
  if (existing) {
    await saveSubscription(existing, locale)
    return true
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(config.public_key),
  })
  try {
    await saveSubscription(subscription, locale)
    return true
  } catch (error) {
    await subscription.unsubscribe()
    throw error
  }
}

export async function unregisterRoomPushSubscription(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
  const registration = await navigator.serviceWorker.getRegistration()
  if (!registration) return
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return
  await api.deleteWithBody('/api/v1/rooms/push-subscriptions', { endpoint: subscription.endpoint })
  await subscription.unsubscribe()
}

// Keeps the one shared service-worker subscription registered when any
// authenticated Sharedrive PWA is opened. It deliberately never prompts here;
// notification permission is requested only from the explicit Rooms control.
export function ChatPushRegistration() {
  const { locale } = useI18n()

  useEffect(() => {
    if (!supportsPushNotifications()) return
    let cancelled = false
    void (async () => {
      try {
        const [currentUser, config] = await Promise.all([
          api.get<{ chat_notifications_enabled?: boolean }>('/api/v1/me'),
          api.get<PushConfig>('/api/v1/rooms/push-config'),
        ])
        if (cancelled || currentUser.chat_notifications_enabled === false || !config.enabled) return
        await subscribeRoomPush(config, locale)
      } catch {
        // A later explicit Rooms action exposes failures without disrupting the app.
      }
    })()
    return () => { cancelled = true }
  }, [locale])

  return null
}

export function ChatPushNotifications() {
  const { t, locale } = useI18n()
  const [config, setConfig] = useState<PushConfig | null>(null)
  const [supported, setSupported] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [busy, setBusy] = useState(true)
  const [chatNotificationsEnabled, setChatNotificationsEnabled] = useState(true)
  const [permission, setPermission] = useState<NotificationPermission>('default')

  useEffect(() => {
    let cancelled = false
    const supportedHere = supportsPushNotifications()
    setSupported(supportedHere)
    if (!supportedHere) { setPermission('denied'); setBusy(false); return }
    setPermission(Notification.permission)
    void (async () => {
      try {
        const [currentUser, serverConfig] = await Promise.all([
          api.get<{ chat_notifications_enabled?: boolean }>('/api/v1/me'),
          api.get<PushConfig>('/api/v1/rooms/push-config'),
        ])
        if (cancelled) return
        setChatNotificationsEnabled(currentUser.chat_notifications_enabled !== false)
        setConfig(serverConfig)
        if (!serverConfig.enabled || currentUser.chat_notifications_enabled === false) return
        const registration = await navigator.serviceWorker.getRegistration()
        const existing = await registration?.pushManager.getSubscription()
        if (cancelled) return
        if (existing && Notification.permission === 'granted') {
          await saveSubscription(existing, locale)
          if (!cancelled) setSubscribed(true)
        }
      } catch {
        if (!cancelled) setConfig({ enabled: false })
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => { cancelled = true }
  }, [locale])

  const toggleChatNotifications = async () => {
    const enabled = !(chatNotificationsEnabled && subscribed && permission === 'granted')
    setBusy(true)
    try {
      if (!enabled) {
        await api.patch('/api/v1/me', { chat_notifications_enabled: false })
        setChatNotificationsEnabled(false)
        setSubscribed(false)
        await unregisterRoomPushSubscription()
        toast.success(t('rooms.pushDisabled'))
        return
      }
      if (!config?.enabled || !config.public_key) {
        toast.error(t('rooms.pushUnavailable'))
        return
      }
      // Request directly in the click handler, before network or service-worker waits.
      const nextPermission = Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission
      setPermission(nextPermission)
      if (nextPermission !== 'granted') {
        toast.error(t('rooms.pushPermissionDenied'))
        return
      }
      const active = await subscribeRoomPush(config, locale)
      if (!active) {
        toast.error(t('rooms.pushFailed'))
        return
      }
      await api.patch('/api/v1/me', { chat_notifications_enabled: true })
      setChatNotificationsEnabled(true)
      setSubscribed(true)
      toast.success(t('rooms.pushEnabled'))
    } catch {
      toast.error(t('rooms.pushFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (!supported) return <p className="mt-2 px-2 py-2 text-xs text-muted">{t('rooms.pushPermissionDenied')}</p>

  const active = chatNotificationsEnabled && subscribed && permission === 'granted'

  return <><div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-subtle px-3 py-2 text-xs text-muted"><span className="flex items-center gap-2"><Bell size={15} />{t(active ? 'rooms.pushDisable' : 'rooms.pushEnable')}</span><button type="button" onClick={() => { void toggleChatNotifications() }} disabled={busy || !config?.enabled} aria-pressed={active} aria-label={active ? t('rooms.pushDisable') : t('rooms.pushEnable')} className={active ? 'relative h-6 w-11 shrink-0 rounded-full bg-brand-600 transition-colors disabled:opacity-60' : 'relative h-6 w-11 shrink-0 rounded-full bg-zinc-400 transition-colors dark:bg-zinc-700 disabled:opacity-60'}><span className={active ? 'absolute left-0 top-1 h-4 w-4 translate-x-6 rounded-full bg-white transition-transform' : 'absolute left-0 top-1 h-4 w-4 translate-x-1 rounded-full bg-white transition-transform'} />{busy && <Loader2 size={12} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 animate-spin text-zinc-700" />}</button></div>{permission === 'denied' && <p className="px-2 py-2 text-xs text-amber-600 dark:text-amber-400">{t('rooms.pushPermissionDenied')}</p>}{config && !config.enabled && <p className="px-2 py-2 text-xs text-muted">{t('rooms.pushUnavailable')}</p>}</>
}

