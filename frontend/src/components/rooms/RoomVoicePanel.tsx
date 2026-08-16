import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Phone, PhoneOff, Users } from 'lucide-react'
import { Room as LiveKitRoom, RoomEvent, Track } from 'livekit-client'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

interface VoiceToken { url: string; token: string }

export function RoomVoicePanel({ roomID, guest = false }: Readonly<{ roomID: string; guest?: boolean }>) {
  const { t } = useI18n()
  const roomRef = useRef<LiveKitRoom | undefined>(undefined)
  const audioElements = useRef<HTMLAudioElement[]>([])
  const [status, setStatus] = useState<'idle' | 'joining' | 'connected' | 'reconnecting' | 'error'>('idle')
  const [muted, setMuted] = useState(false)
  const [participants, setParticipants] = useState<string[]>([])
  const [error, setError] = useState('')

  const syncParticipants = () => {
    const room = roomRef.current
    if (!room) return
    setParticipants([room.localParticipant.name || room.localParticipant.identity, ...[...room.remoteParticipants.values()].map(item => item.name || item.identity)])
  }

  const leave = async () => {
    roomRef.current?.disconnect()
    roomRef.current = undefined
    audioElements.current.forEach(element => element.remove())
    audioElements.current = []
    setParticipants([]); setMuted(false); setStatus('idle')
  }

  const join = async () => {
    setError(''); setStatus('joining')
    try {
      const prefix = guest ? '/api/v1/guest/rooms' : '/api/v1/rooms'
      const details = await api.post<VoiceToken>(`${prefix}/${roomID}/media-token`, {})
      const room = new LiveKitRoom()
      roomRef.current = room
      room.on(RoomEvent.ConnectionStateChanged, state => setStatus(state === 'reconnecting' ? 'reconnecting' : state === 'connected' ? 'connected' : state === 'disconnected' ? 'idle' : 'joining'))
      room.on(RoomEvent.ParticipantConnected, syncParticipants).on(RoomEvent.ParticipantDisconnected, syncParticipants)
      room.on(RoomEvent.TrackSubscribed, track => { if (track.kind === Track.Kind.Audio) { const element = track.attach() as HTMLAudioElement; element.autoplay = true; document.body.append(element); audioElements.current.push(element) } })
      room.on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(element => element.remove()))
      await room.connect(details.url, details.token)
      await room.localParticipant.setMicrophoneEnabled(true)
      setMuted(false); syncParticipants()
    } catch (cause) { await leave(); setError(cause instanceof Error ? cause.message : t('rooms.voiceConnectFailed')) }
  }

  const toggleMute = async () => {
    const room = roomRef.current
    if (!room) return
    await room.localParticipant.setMicrophoneEnabled(muted)
    setMuted(value => !value)
  }

  useEffect(() => () => { leave().catch(() => undefined) }, [])

  return <section className="mt-6 rounded-xl border border-zinc-200 p-4 dark:border-[#2d3148]" aria-label={t('rooms.voice')}>
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-semibold"><Mic size={18} /> {t('rooms.voice')}</h2><p className="mt-1 text-sm text-muted">{status === 'reconnecting' ? t('rooms.voiceReconnecting') : status === 'connected' ? t('rooms.voiceConnected') : t('rooms.voiceDescription')}</p></div>{status !== 'connected' && status !== 'reconnecting' ? <button type="button" onClick={() => join().catch(() => undefined)} disabled={status === 'joining'} className="notes-primary-button"><Phone size={16} /> {status === 'joining' ? t('rooms.voiceJoining') : t('rooms.voiceJoin')}</button> : <div className="flex gap-2"><button type="button" onClick={() => toggleMute().catch(() => undefined)} className="notes-secondary-button">{muted ? <MicOff size={16} /> : <Mic size={16} />}{muted ? t('rooms.voiceUnmute') : t('rooms.voiceMute')}</button><button type="button" onClick={() => leave().catch(() => undefined)} className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-600 dark:border-red-900"><PhoneOff size={16} /> {t('rooms.voiceLeave')}</button></div>}</div>
    {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    {status === 'connected' && <p className="mt-3 flex items-center gap-2 text-sm text-muted"><Users size={16} /> {t('rooms.voiceParticipants', { names: participants.join(', ') })}</p>}
  </section>
}
