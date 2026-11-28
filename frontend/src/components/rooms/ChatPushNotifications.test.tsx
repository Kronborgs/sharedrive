// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(), patch: vi.fn(), post: vi.fn(), remove: vi.fn(),
  success: vi.fn(), error: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ api: { get: mocks.get, patch: mocks.patch, post: mocks.post, deleteWithBody: mocks.remove } }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'da' }) }))
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }))
import { ChatPushNotifications } from './ChatPushNotifications'

describe('ChatPushNotifications', () => {
  const subscription = { endpoint: 'https://push.example/sub', toJSON: () => ({ endpoint: 'https://push.example/sub', keys: { p256dh: 'key', auth: 'auth' } }), unsubscribe: vi.fn().mockResolvedValue(true) }
  const getSubscription = vi.fn()
  const subscribe = vi.fn()
  const requestPermission = vi.fn()
  const notification = { permission: 'default', requestPermission }

  beforeEach(() => {
    vi.clearAllMocks()
    notification.permission = 'default'
    mocks.get.mockImplementation((path: string) => Promise.resolve(path === '/api/v1/me' ? { chat_notifications_enabled: true } : { enabled: true, public_key: 'AQ' }))
    mocks.patch.mockResolvedValue(undefined)
    mocks.post.mockResolvedValue(undefined)
    mocks.remove.mockResolvedValue(undefined)
    getSubscription.mockResolvedValue(null)
    subscribe.mockResolvedValue(subscription)
    requestPermission.mockImplementation(async () => { notification.permission = 'granted'; return 'granted' })
    const registration = { pushManager: { getSubscription, subscribe } }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn().mockResolvedValue(registration), ready: Promise.resolve(registration) } })
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('Notification', notification)
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('requests permission immediately on click and activates only after registration succeeds', async () => {
    render(<ChatPushNotifications />)
    const button = await screen.findByRole('button', { name: 'rooms.pushEnable' })
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    fireEvent.click(button)
    expect(requestPermission).toHaveBeenCalledOnce()
    expect(mocks.patch).not.toHaveBeenCalled()
    await waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'))
    expect(mocks.post).toHaveBeenCalledWith('/api/v1/rooms/push-subscriptions', expect.objectContaining({ locale: 'da', endpoint: subscription.endpoint }))
    expect(mocks.patch).toHaveBeenCalledWith('/api/v1/me', { chat_notifications_enabled: true })
  })

  it('stays off and does not update the account when permission is denied', async () => {
    requestPermission.mockImplementation(async () => { notification.permission = 'denied'; return 'denied' })
    render(<ChatPushNotifications />)
    const button = await screen.findByRole('button', { name: 'rooms.pushEnable' })
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('rooms.pushPermissionDenied'))
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(mocks.patch).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('turns off an existing subscription', async () => {
    notification.permission = 'granted'
    getSubscription.mockResolvedValue(subscription)
    render(<ChatPushNotifications />)
    const button = await screen.findByRole('button', { name: 'rooms.pushDisable' })
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('false'))
    expect(mocks.patch).toHaveBeenCalledWith('/api/v1/me', { chat_notifications_enabled: false })
    expect(mocks.remove).toHaveBeenCalledWith('/api/v1/rooms/push-subscriptions', { endpoint: subscription.endpoint })
    expect(subscription.unsubscribe).toHaveBeenCalled()
  })
})
