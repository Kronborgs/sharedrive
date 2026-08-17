import { useEffect, useRef, useState } from 'react'
import { MonitorUp, Mic, MicOff, Phone, PhoneOff, Users } from 'lucide-react'
import { Room as LiveKitRoom, RoomEvent, Track, type RemoteTrack } from 'livekit-client'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

interface VoiceToken { url: string; token: string }

interface SharedScreen {
  id: string
  participantName: string
  track: RemoteTrack
}

function connectionStatus(state: string): 'idle' | 'joining' | 'connected' | 'reconnecting' {
  if (state === 'reconnecting') return 'reconnecting'
  if (state === 'connected') return 'connected'
  if (state === 'disconnected') return 'idle'
  return 'joining'
}

function voiceDescriptionKey(status: string): 'rooms.voiceReconnecting' | 'rooms.voiceConnected' | 'rooms.voiceDescription' {
  if (status === 'reconnecting') return 'rooms.voiceReconnecting'
  if (status === 'connected') return 'rooms.voiceConnected'
  return 'rooms.voiceDescription'
}

function SharedScreenVideo({ sharedScreen, captionsLabel }: Readonly<{ sharedScreen: SharedScreen; captionsLabel: string }>) {
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return undefined
    sharedScreen.track.attach(video)
    return () => { sharedScreen.track.detach(video) }
  }, [sharedScreen.track])
  return <article className="overflow-hidden rounded-lg border border-zinc-200 bg-black dark:border-[#2d3148]"><video ref={videoRef} autoPlay playsInline className="aspect-video w-full"><track kind="captions" srcLang="da" label={captionsLabel} src="data:text/vtt;charset=utf-8,WEBVTT" /></video><p className="bg-white px-3 py-2 text-xs text-zinc-700 dark:bg-[#1a1d27] dark:text-slate-300">{sharedScreen.participantName}</p></article>
}

export function RoomVoicePanel({ roomID, guest = false, canShareScreen = true }: Readonly<{ roomID: string; guest?: boolean; canShareScreen?: boolean }>) {
  const { t } = useI18n()
  const roomRef = useRef<LiveKitRoom | undefined>(undefined)
  const audioElements = useRef<HTMLAudioElement[]>([])
  const [status, setStatus] = useState<'idle' | 'joining' | 'connected' | 'reconnecting' | 'error'>('idle')
  const [muted, setMuted] = useState(false)
  const [participants, setParticipants] = useState<string[]>([])
  const [activeSpeakers, setActiveSpeakers] = useState<string[]>([])
  const [sharedScreens, setSharedScreens] = useState<SharedScreen[]>([])
  const [sharingScreen, setSharingScreen] = useState(false)
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
    setParticipants([]); setActiveSpeakers([]); setSharedScreens([]); setSharingScreen(false); setMuted(false); setStatus('idle')
  }

  const join = async () => {
    setError(''); setStatus('joining')
    try {
      const prefix = guest ? '/api/v1/guest/rooms' : '/api/v1/rooms'
      const details = await api.post<VoiceToken>(`${prefix}/${roomID}/media-token`, {})
      const room = new LiveKitRoom()
      roomRef.current = room
      room.on(RoomEvent.ConnectionStateChanged, state => setStatus(connectionStatus(state)))
      room.on(RoomEvent.ParticipantConnected, syncParticipants).on(RoomEvent.ParticipantDisconnected, syncParticipants)
      room.on(RoomEvent.ActiveSpeakersChanged, speakers => setActiveSpeakers(speakers.map(speaker => speaker.name || speaker.identity)))
      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === Track.Kind.Audio) {
          const element = track.attach() as HTMLAudioElement
          element.autoplay = true
          document.body.append(element)
          audioElements.current.push(element)
        }
        if (track.kind === Track.Kind.Video && publication.source === Track.Source.ScreenShare) {
          const screenID = track.sid ?? `${participant.identity}:screen`
          setSharedScreens(screens => [...screens.filter(screen => screen.id !== screenID), { id: screenID, participantName: participant.name || participant.identity, track: track as RemoteTrack }])
        }
      })
      room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
        track.detach().forEach(element => element.remove())
        if (publication.source === Track.Source.ScreenShare && track.sid) setSharedScreens(screens => screens.filter(screen => screen.id !== track.sid))
      })
      room.on(RoomEvent.LocalTrackUnpublished, publication => { if (publication.source === Track.Source.ScreenShare) setSharingScreen(false) })
      await room.connect(details.url, details.token)
      await room.localParticipant.setMicrophoneEnabled(true)
      setMuted(false); syncParticipants()
    } catch {
      await leave()
      setError(t('rooms.voiceConnectFailed'))
    }
  }

  const toggleMute = async () => {
    const room = roomRef.current
    if (!room) return
    await room.localParticipant.setMicrophoneEnabled(muted)
    setMuted(value => !value)
  }

  const toggleScreenShare = async () => {
    const room = roomRef.current
    if (!room) return
    setError('')
    try {
      await room.localParticipant.setScreenShareEnabled(!sharingScreen, { audio: false, contentHint: 'detail' })
      setSharingScreen(value => !value)
    } catch {
      setError(t('rooms.screenShareFailed'))
    }
  }

  useEffect(() => () => { leave().catch(() => undefined) }, [])

  const description = t(voiceDescriptionKey(status))
  const screenShareSupported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia)
  return <section className="mt-6 rounded-xl border border-zinc-200 p-4 dark:border-[#2d3148]" aria-label={t('rooms.voice')}>
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-semibold"><Mic size={18} /> {t('rooms.voice')}</h2><p className="mt-1 text-sm text-muted">{description}</p></div>{status !== 'connected' && status !== 'reconnecting' ? <button type="button" onClick={() => join().catch(() => undefined)} disabled={status === 'joining'} className="notes-primary-button"><Phone size={16} /> {status === 'joining' ? t('rooms.voiceJoining') : t('rooms.voiceJoin')}</button> : <div className="flex flex-wrap gap-2"><button type="button" onClick={() => toggleMute().catch(() => undefined)} className="notes-secondary-button">{muted ? <MicOff size={16} /> : <Mic size={16} />}{muted ? t('rooms.voiceUnmute') : t('rooms.voiceMute')}</button>{canShareScreen && screenShareSupported && <button type="button" onClick={() => toggleScreenShare().catch(() => undefined)} className="notes-secondary-button"><MonitorUp size={16} />{sharingScreen ? t('rooms.screenShareStop') : t('rooms.screenShareStart')}</button>}<button type="button" onClick={() => leave().catch(() => undefined)} className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-600 dark:border-red-900"><PhoneOff size={16} /> {t('rooms.voiceLeave')}</button></div>}</div>
    {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    {status === 'connected' && <p className="mt-3 flex items-center gap-2 text-sm text-muted"><Users size={16} /> {t('rooms.voiceParticipants', { names: participants.join(', ') })}</p>}
    {status === 'connected' && activeSpeakers.length > 0 && <p className="mt-1 text-sm text-muted">{t('rooms.voiceSpeaking', { names: activeSpeakers.join(', ') })}</p>}
    {status === 'connected' && canShareScreen && !screenShareSupported && <p className="mt-3 text-sm text-muted">{t('rooms.screenShareUnsupported')}</p>}
    {sharedScreens.length > 0 && <section className="mt-4" aria-label={t('rooms.screenShares')}><h3 className="mb-2 text-sm font-semibold">{t('rooms.screenShares')}</h3><div className="grid gap-3 lg:grid-cols-2">{sharedScreens.map(sharedScreen => <SharedScreenVideo key={sharedScreen.id} sharedScreen={sharedScreen} captionsLabel={t('rooms.screenCaptions')} />)}</div></section>}
  </section>
}
