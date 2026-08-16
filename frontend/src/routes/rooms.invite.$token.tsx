import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { DoorOpen } from 'lucide-react'
import { acceptRoomInvite } from '@/lib/rooms'
import { useI18n } from '@/lib/i18n'

export const Route = createFileRoute('/rooms/invite/$token')({ component: RoomInvitePage })

function RoomInvitePage() {
  const { t } = useI18n()
  const { token } = Route.useParams()
  const [displayName, setDisplayName] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  return <main className="flex min-h-screen items-center justify-center bg-zinc-50 p-4 dark:bg-[#0f1117]">
    <form className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-[#2d3148] dark:bg-[#151821]" onSubmit={event => {
      event.preventDefault()
      setPending(true)
      setError('')
      acceptRoomInvite(token, displayName.trim())
        .then(result => window.location.replace(`/rooms/guest/${result.room_id}`))
        .catch(() => { setError(t('rooms.inviteInvalid')); setPending(false) })
    }}>
      <DoorOpen className="mb-4 text-brand-600" size={32} />
      <h1 className="text-2xl font-semibold text-zinc-950 dark:text-white">{t('rooms.joinAsGuest')}</h1>
      <p className="mt-2 text-sm text-muted">{t('rooms.joinGuestDescription')}</p>
      <label className="mt-5 block text-sm"><span className="block">{t('rooms.yourName')}</span>
        <input autoFocus required minLength={1} maxLength={80} value={displayName} onChange={event => setDisplayName(event.target.value)} className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 dark:border-[#3a3f58] dark:bg-[#0f1117]" />
      </label>
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      <button type="submit" disabled={pending || !displayName.trim()} className="mt-5 w-full rounded-lg bg-brand-600 px-4 py-2 text-white disabled:opacity-50">{pending ? t('rooms.guestOpening') : t('rooms.join')}</button>
    </form>
  </main>
}
