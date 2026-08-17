import { useEffect, useRef, useState } from 'react'
import { MonitorUp, Mic, MicOff, Phone, PhoneOff, Users } from 'lucide-react'
import { Room as LiveKitRoom, RoomEvent, Track, type RemoteTrack } from 'livekit-client'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

interface VoiceToken { url: string; token: string }
type MediaMode = 'voice' | 'screen' | 'watch'

interface SharedScreen {
  id: string
  participantName: string
  track: RemoteTrack
}
type Translator = ReturnType<typeof useI18n>['t']

interface MeetingControlsProps {
  status: 'idle' | 'joining' | 'connected' | 'reconnecting' | 'error'
  meetingActive: boolean
  muted: boolean
  canShareScreen: boolean
  screenShareSupported: boolean
  sharingScreen: boolean
  t: Translator
  onJoin: (mode: MediaMode) => Promise<void>
  onToggleMute: () => Promise<void>
  onToggleScreenShare: () => Promise<void>
  onLeave: () => Promise<void>
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

function meetingActionLabel(status: MeetingControlsProps['status'], meetingActive: boolean, t: Translator) {
  if (status === 'joining') return t('rooms.voiceJoining')
  if (meetingActive) return t('rooms.joinMeeting')
  return t('rooms.startMeeting')
}

function MeetingControls(props: Readonly<MeetingControlsProps>) {
  const isConnected = props.status === 'connected' || props.status === 'reconnecting'
  const joinMode: MediaMode = props.meetingActive ? 'watch' : 'voice'
  const actionLabel = meetingActionLabel(props.status, props.meetingActive, props.t)
  if (!isConnected) {
    return <div className="flex flex-wrap gap-2"><button type="button" onClick={() => props.onJoin(joinMode).catch(() => undefined)} disabled={props.status === 'joining'} className="notes-primary-button"><Phone size={16} /> {actionLabel}</button>{props.canShareScreen && props.screenShareSupported && <button type="button" onClick={() => props.onToggleScreenShare().catch(() => undefined)} disabled={props.status === 'joining'} className="notes-secondary-button"><MonitorUp size={16} />{props.t('rooms.screenShareStart')}</button>}</div>
  }
  return <div className="flex flex-wrap gap-2"><button type="button" onClick={() => props.onToggleMute().catch(() => undefined)} className="notes-secondary-button">{props.muted ? <MicOff size={16} /> : <Mic size={16} />}{props.muted ? props.t('rooms.voiceUnmute') : props.t('rooms.voiceMute')}</button>{props.canShareScreen && props.screenShareSupported && <button type="button" onClick={() => props.onToggleScreenShare().catch(() => undefined)} className="notes-secondary-button"><MonitorUp size={16} />{props.sharingScreen ? props.t('rooms.screenShareStop') : props.t('rooms.screenShareStart')}</button>}<button type="button" onClick={() => props.onLeave().catch(() => undefined)} className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-600 dark:border-red-900"><PhoneOff size={16} /> {props.t('rooms.voiceLeave')}</button></div>
}

export function RoomVoicePanel({ roomID, guest = false, canShareScreen = true, meetingActive = false }: Readonly<{ roomID: string; guest?: boolean; canShareScreen?: boolean; meetingActive?: boolean }>) {
  const { t } = useI18n()
  const roomRef = useRef<LiveKitRoom | undefined>(undefined)
  const mediaModeRef = useRef<MediaMode | undefined>(undefined)
  const audioElements = useRef<HTMLAudioElement[]>([])
  const [status, setStatus] = useState<'idle' | 'joining' | 'connected' | 'reconnecting' | 'error'>('idle')
  const [muted, setMuted] = useState(false)
  const [participants, setParticipants] = useState<string[]>([])
  const [activeSpeakers, setActiveSpeakers] = useState<string[]>([])
  const [sharedScreens, setSharedScreens] = useState<SharedScreen[]>([])
  const [sharingScreen, setSharingScreen] = useState(false)
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false)
  const [error, setError] = useState('')

  const syncParticipants = () => {
    const room = roomRef.current
    if (!room) return
    setParticipants([room.localParticipant.name || room.localParticipant.identity, ...[...room.remoteParticipants.values()].map(item => item.name || item.identity)])
  }

  const leave = async () => {
    roomRef.current?.disconnect()
    roomRef.current = undefined
    mediaModeRef.current = undefined
    audioElements.current.forEach(element => element.remove())
    audioElements.current = []
    setParticipants([]); setActiveSpeakers([]); setSharedScreens([]); setSharingScreen(false); setMicrophoneEnabled(false); setMuted(false); setStatus('idle')
  }

  const addSharedScreen = (track: RemoteTrack, participantName: string) => {
    const screenID = track.sid ?? `${participantName}:screen`
    setSharedScreens(screens => [...screens.filter(screen => screen.id !== screenID), { id: screenID, participantName, track }])
  }

  const syncSharedScreens = (room: LiveKitRoom) => {
    room.remoteParticipants.forEach(participant => {
      participant.trackPublications.forEach(publication => {
        const track = publication.track
        if (publication.source !== Track.Source.ScreenShare || !track || track.kind !== Track.Kind.Video) return
        addSharedScreen(track as RemoteTrack, participant.name || participant.identity)
      })
    })
  }

  const join = async (mode: MediaMode = 'voice', reportFailure = true) => {
    const withMicrophone = mode === 'voice'
    setError(''); setStatus('joining')
    try {
      const prefix = guest ? '/api/v1/guest/rooms' : '/api/v1/rooms'
      const details = await api.post<VoiceToken>(`${prefix}/${roomID}/media-token?mode=${mode}`, {})
      const room = new LiveKitRoom()
      roomRef.current = room
      mediaModeRef.current = mode
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
          addSharedScreen(track as RemoteTrack, participant.name || participant.identity)
        }
      })
      room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
        track.detach().forEach(element => element.remove())
        if (publication.source === Track.Source.ScreenShare && track.sid) setSharedScreens(screens => screens.filter(screen => screen.id !== track.sid))
      })
      room.on(RoomEvent.LocalTrackUnpublished, publication => { if (publication.source === Track.Source.ScreenShare) setSharingScreen(false) })
      await room.connect(details.url, details.token, { autoSubscribe: true })
      if (withMicrophone) await room.localParticipant.setMicrophoneEnabled(true)
      setMicrophoneEnabled(withMicrophone); setMuted(!withMicrophone); syncParticipants(); syncSharedScreens(room)
    } catch {
      await leave()
      if (reportFailure) setError(t('rooms.voiceConnectFailed'))
    }
  }

  const toggleMute = async () => {
    const room = roomRef.current
    if (!room) return
    if (muted && mediaModeRef.current === 'watch') {
      await leave()
      await join('voice')
      return
    }
    await room.localParticipant.setMicrophoneEnabled(muted)
    setMuted(value => !value); setMicrophoneEnabled(muted)
  }

  const toggleScreenShare = async () => {
    let room = roomRef.current
    if (!room || mediaModeRef.current === 'watch') {
      if (room) await leave()
      await join('screen')
      room = roomRef.current
    }
    if (!room) return
    setError('')
    try {
      await room.localParticipant.setScreenShareEnabled(!sharingScreen, { audio: false, contentHint: 'detail' })
      setSharingScreen(value => !value)
      if (sharingScreen && !microphoneEnabled) await leave()
    } catch {
      setError(t('rooms.screenShareFailed'))
    }
  }

  useEffect(() => () => { leave().catch(() => undefined) }, [])

  const description = status === 'connected' && !microphoneEnabled && !sharingScreen ? t('rooms.screenShareReady') : t(voiceDescriptionKey(status))
  const screenShareSupported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia)
  return <section className="mt-6 rounded-xl border border-zinc-200 p-4 dark:border-[#2d3148]" aria-label={t('rooms.meeting')}>
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 text-lg font-semibold"><Mic size={18} /> {t('rooms.meeting')}</h2><p className="mt-1 text-sm text-muted">{description}</p>{meetingActive && status === 'idle' && <p className="mt-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">{t('rooms.meetingInProgress')}</p>}</div><MeetingControls status={status} meetingActive={meetingActive} muted={muted} canShareScreen={canShareScreen} screenShareSupported={screenShareSupported} sharingScreen={sharingScreen} t={t} onJoin={join} onToggleMute={toggleMute} onToggleScreenShare={toggleScreenShare} onLeave={leave} /></div>
    {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    {status === 'connected' && <p className="mt-3 flex items-center gap-2 text-sm text-muted"><Users size={16} /> {t('rooms.voiceParticipants', { names: participants.join(', ') })}</p>}
    {status === 'connected' && activeSpeakers.length > 0 && <p className="mt-1 text-sm text-muted">{t('rooms.voiceSpeaking', { names: activeSpeakers.join(', ') })}</p>}
    {status === 'connected' && canShareScreen && !screenShareSupported && <p className="mt-3 text-sm text-muted">{t('rooms.screenShareUnsupported')}</p>}
    {sharedScreens.length > 0 && <section className="mt-4" aria-label={t('rooms.screenShares')}><h3 className="mb-2 text-sm font-semibold">{t('rooms.screenShares')}</h3><div className="grid gap-3 lg:grid-cols-2">{sharedScreens.map(sharedScreen => <SharedScreenVideo key={sharedScreen.id} sharedScreen={sharedScreen} captionsLabel={t('rooms.screenCaptions')} />)}</div></section>}
  </section>
}
