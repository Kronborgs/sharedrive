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

async function subscribeRoomPush(config: PushConfig, locale: string, requestPermission: boolean): Promise<boolean> {
  if (!config.enabled || !config.public_key || !supportsPushNotifications()) return false
  const registration = await navigator.serviceWorker.ready
  const existing = await registration.pushManager.getSubscription()
  if (existing) {
    await saveSubscription(existing, locale)
    return true
  }

  const permission = Notification.permission === 'default' && requestPermission
    ? await Notification.requestPermission()
    : Notification.permission
  if (permission !== 'granted') return false

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
  const registration = await navigator.serviceWorker.ready
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
        await subscribeRoomPush(config, locale, false)
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

  useEffect(() => {
    let cancelled = false
    const supportedHere = supportsPushNotifications()
    setSupported(supportedHere)
    if (!supportedHere) { setBusy(false); return }
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
        const registration = await navigator.serviceWorker.ready
        const existing = await registration.pushManager.getSubscription()
        if (cancelled) return
        setSubscribed(Boolean(existing))
        if (existing) await saveSubscription(existing, locale)
      } catch {
        if (!cancelled) setConfig({ enabled: false })
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()
    return () => { cancelled = true }
  }, [locale])

  const toggleChatNotifications = async () => {
    const enabled = !chatNotificationsEnabled
    setBusy(true)
    try {
      await api.patch('/api/v1/me', { chat_notifications_enabled: enabled })
      setChatNotificationsEnabled(enabled)
      if (!enabled) {
        await unregisterRoomPushSubscription()
        setSubscribed(false)
        return
      }
      if (!config?.enabled || !config.public_key) {
        toast.error(t('rooms.pushUnavailable'))
        return
      }
      const active = await subscribeRoomPush(config, locale, true)
      setSubscribed(active)
      if (active) toast.success(t('rooms.pushEnabled'))
      else toast.error(t('rooms.pushPermissionDenied'))
    } catch {
      toast.error(t('rooms.pushFailed'))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async () => {
    if (!config?.enabled || !config.public_key || busy || !chatNotificationsEnabled) return
    setBusy(true)
    try {
      const registration = await navigator.serviceWorker.ready
      const current = await registration.pushManager.getSubscription()
      if (current) {
        await unregisterRoomPushSubscription()
        setSubscribed(false)
        toast.success(t('rooms.pushDisabled'))
        return
      }
      const active = await subscribeRoomPush(config, locale, true)
      setSubscribed(active)
      if (active) toast.success(t('rooms.pushEnabled'))
      else toast.error(t('rooms.pushPermissionDenied'))
    } catch {
      toast.error(t('rooms.pushFailed'))
    } finally {
      setBusy(false)
    }
  }

  const sendTest = async () => {
    if (!config?.enabled || !subscribed || busy) return
    setBusy(true)
    try {
      const result = await api.post<{ subscriptions: number }>('/api/v1/rooms/push-subscriptions/test', {})
      if (result.subscriptions > 0) toast.success(t('rooms.pushTestSent'))
      else toast.error(t('rooms.pushTestUnavailable'))
    } catch {
      toast.error(t('rooms.pushFailed'))
    } finally {
      setBusy(false)
    }
  }
  if (!supported) return null

  const globalToggle = <button type="button" onClick={() => { void toggleChatNotifications() }} disabled={busy} className="mt-2 flex min-h-10 w-full items-center justify-center rounded-lg border border-subtle px-3 py-2 text-xs font-medium text-muted hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-60 dark:hover:bg-[#2d3148] dark:hover:text-slate-100">
    {chatNotificationsEnabled ? 'Slå chat-notifikationer fra' : 'Slå chat-notifikationer til'}
  </button>

  let notificationIcon = <Bell size={15} />
  if (busy) notificationIcon = <Loader2 size={15} className="animate-spin" />
  else if (subscribed) notificationIcon = <BellOff size={15} />

  return <>{globalToggle}{config && !config.enabled ? <p className="px-2 py-2 text-xs text-muted">{t('rooms.pushUnavailable')}</p> : <button type="button" onClick={() => { void toggle() }} disabled={busy || !chatNotificationsEnabled || !config?.enabled} aria-pressed={subscribed} className="mt-2 flex min-h-10 w-full items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-left text-xs font-medium text-muted hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-60 dark:hover:bg-[#2d3148] dark:hover:text-slate-100">
    {notificationIcon}
    <span>{subscribed ? t('rooms.pushDisable') : t('rooms.pushEnable')}</span>
  </button>}{subscribed && config?.enabled && <button type="button" onClick={() => { void sendTest() }} disabled={busy} className="mt-2 flex min-h-10 w-full items-center justify-center rounded-lg border border-subtle px-3 py-2 text-xs font-medium text-muted hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-60 dark:hover:bg-[#2d3148] dark:hover:text-slate-100">{t('rooms.pushTest')}</button>}</>
}