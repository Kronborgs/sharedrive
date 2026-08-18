import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Camera, CameraOff, Maximize2, MonitorUp, Mic, MicOff, Phone, PhoneOff, RefreshCw, Users, X } from 'lucide-react'
import { Room as LiveKitRoom, RoomEvent, Track, type RemoteTrack } from 'livekit-client'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

interface VoiceToken { url: string; token: string }
type MediaMode = 'voice' | 'screen' | 'watch'

interface SharedScreen {
  id: string
  participantName: string
  track: RemoteTrack
  isSwitching: boolean
}
interface RemoteCamera { id: string; participantName: string; track: RemoteTrack }
type SharedScreenSetter = Dispatch<SetStateAction<SharedScreen[]>>
type Translator = ReturnType<typeof useI18n>['t']

interface MeetingControlsProps {
  status: 'idle' | 'joining' | 'connected' | 'reconnecting' | 'error'
  meetingActive: boolean
  muted: boolean
  canShareScreen: boolean
  screenShareSupported: boolean
  sharingScreen: boolean
  cameraEnabled: boolean
  compact: boolean
  t: Translator
  onJoin: (mode: MediaMode) => Promise<void>
  onToggleMute: () => Promise<void>
  onToggleScreenShare: () => Promise<void>
  onChangeScreenShare: () => Promise<void>
  onToggleCamera: () => Promise<void>
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

type ScreenShareSignal = 'switching' | 'stopped'

function removeSharedScreenAfterTrackChange(setSharedScreens: SharedScreenSetter, participantID: string, track: RemoteTrack) {
  window.setTimeout(() => {
    setSharedScreens(screens => screens.filter(screen => screen.id !== participantID || screen.track !== track || screen.isSwitching))
  }, 3000)
}

function screenShareSignal(payload: Uint8Array, topic: string | undefined): ScreenShareSignal | undefined {
  if (topic !== 'sharedrive.rooms.screen-share') return undefined
  try {
    const message = JSON.parse(new TextDecoder().decode(payload)) as { state?: unknown }
    if (message.state === 'switching' || message.state === 'stopped') return message.state
  } catch {
    return undefined
  }
  return undefined
}

async function publishScreenShareSignal(room: LiveKitRoom, state: ScreenShareSignal) {
  const payload = new TextEncoder().encode(JSON.stringify({ state }))
  await room.localParticipant.publishData(payload, { reliable: true, topic: 'sharedrive.rooms.screen-share' })
}

function applyScreenShareSignal(setSharedScreens: SharedScreenSetter, participantID: string, signal: ScreenShareSignal) {
  if (signal === 'switching') {
    setSharedScreens(screens => screens.map(screen => screen.id === participantID ? { ...screen, isSwitching: true } : screen))
    return
  }
  setSharedScreens(screens => screens.filter(screen => screen.id !== participantID))
}

function SharedScreenTrackVideo({ track, captionsLabel, className }: Readonly<{ track: RemoteTrack; captionsLabel: string; className: string }>) {
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return undefined
    track.attach(video)
    return () => { track.detach(video) }
  }, [track])
  return <video ref={videoRef} autoPlay playsInline disablePictureInPicture className={className}><track kind="captions" srcLang="da" label={captionsLabel} src="data:text/vtt;charset=utf-8,WEBVTT" /></video>
}

function RemoteCameraVideo({ camera, captionsLabel }: Readonly<{ camera: RemoteCamera; captionsLabel: string }>) {
  return <article className="overflow-hidden rounded-lg border border-subtle bg-surface"><SharedScreenTrackVideo track={camera.track} captionsLabel={captionsLabel} className="aspect-video w-full object-cover" /><p className="px-3 py-2 text-xs text-muted">{camera.participantName}</p></article>
}

function SharedScreenVideo({ sharedScreen, captionsLabel }: Readonly<{ sharedScreen: SharedScreen; captionsLabel: string }>) {
  const { t } = useI18n()
  const [popupOpen, setPopupOpen] = useState(false)
  const switchingOverlay = <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-4 text-center text-sm font-medium text-white">{t('rooms.screenShareChanging')}</div>
  return <><article className="relative overflow-hidden rounded-lg border border-zinc-200 bg-black dark:border-[#2d3148]"><SharedScreenTrackVideo track={sharedScreen.track} captionsLabel={captionsLabel} className="aspect-video w-full" />{sharedScreen.isSwitching && switchingOverlay}<button type="button" onClick={() => setPopupOpen(true)} className="absolute right-3 top-3 flex items-center gap-2 rounded-md bg-black/75 px-3 py-2 text-sm font-medium text-white shadow hover:bg-black/90" aria-label={t('rooms.viewScreenPopup')} title={t('rooms.viewScreenPopup')}><Maximize2 size={18} /> {t('rooms.viewScreenPopup')}</button><p className="bg-white px-3 py-2 text-xs text-zinc-700 dark:bg-[#1a1d27] dark:text-slate-300">{sharedScreen.participantName}</p></article><Dialog.Root open={popupOpen} onOpenChange={setPopupOpen}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[110] bg-black/75" /><Dialog.Content className="fixed left-1/2 top-1/2 z-[111] flex max-h-[94vh] w-[min(96vw,90rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-black shadow-2xl dark:border-[#34394f]"><div className="flex shrink-0 items-center justify-between bg-white px-4 py-3 dark:bg-[#1a1d27]"><Dialog.Title className="text-sm font-semibold">{t('rooms.screenPopupTitle', { name: sharedScreen.participantName })}</Dialog.Title><Dialog.Close asChild><button type="button" className="notes-icon-button" aria-label={t('action.close')}><X size={18} /></button></Dialog.Close></div><div className="relative min-h-0"><SharedScreenTrackVideo track={sharedScreen.track} captionsLabel={captionsLabel} className="min-h-0 w-full object-contain" />{sharedScreen.isSwitching && switchingOverlay}</div></Dialog.Content></Dialog.Portal></Dialog.Root></>
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
  const labelClass = props.compact ? 'hidden sm:inline' : undefined
  if (!isConnected) {
    return <div className="flex flex-wrap gap-2"><button type="button" onClick={() => props.onJoin(joinMode).catch(() => undefined)} disabled={props.status === 'joining'} className="notes-primary-button shrink-0" title={actionLabel}><Phone size={16} /><span className={labelClass}> {actionLabel}</span></button>{props.canShareScreen && props.screenShareSupported && <button type="button" onClick={() => props.onToggleScreenShare().catch(() => undefined)} disabled={props.status === 'joining'} className="notes-secondary-button shrink-0" title={props.t('rooms.screenShareStart')}><MonitorUp size={16} /><span className={labelClass}>{props.t('rooms.screenShareStart')}</span></button>}</div>
  }
  return <div className="flex flex-wrap gap-2"><button type="button" onClick={() => props.onToggleMute().catch(() => undefined)} className="notes-secondary-button shrink-0" title={props.muted ? props.t('rooms.voiceUnmute') : props.t('rooms.voiceMute')}>{props.muted ? <MicOff size={16} /> : <Mic size={16} />}<span className={labelClass}>{props.muted ? props.t('rooms.voiceUnmute') : props.t('rooms.voiceMute')}</span></button><button type="button" onClick={() => props.onToggleCamera().catch(() => undefined)} className="notes-secondary-button shrink-0" title={props.cameraEnabled ? props.t('rooms.cameraStop') : props.t('rooms.cameraStart')}>{props.cameraEnabled ? <CameraOff size={16} /> : <Camera size={16} />}<span className={labelClass}>{props.cameraEnabled ? props.t('rooms.cameraStop') : props.t('rooms.cameraStart')}</span></button>{props.canShareScreen && props.screenShareSupported && <>{props.sharingScreen && <button type="button" onClick={() => props.onChangeScreenShare().catch(() => undefined)} className="notes-secondary-button shrink-0" title={props.t('rooms.screenShareChange')}><RefreshCw size={16} /><span className={labelClass}>{props.t('rooms.screenShareChange')}</span></button>}<button type="button" onClick={() => props.onToggleScreenShare().catch(() => undefined)} className="notes-secondary-button shrink-0" title={props.sharingScreen ? props.t('rooms.screenShareStop') : props.t('rooms.screenShareStart')}><MonitorUp size={16} /><span className={labelClass}>{props.sharingScreen ? props.t('rooms.screenShareStop') : props.t('rooms.screenShareStart')}</span></button></>}<button type="button" onClick={() => props.onLeave().catch(() => undefined)} className="flex items-center gap-1.5 rounded-md border border-red-300 px-3 py-2 text-sm text-red-600 dark:border-red-900" title={props.t('rooms.voiceLeave')}><PhoneOff size={16} /><span className={labelClass}> {props.t('rooms.voiceLeave')}</span></button></div>
}

export function RoomVoicePanel({ roomID, guest = false, canShareScreen = true, meetingActive = false, compact = false }: Readonly<{ roomID: string; guest?: boolean; canShareScreen?: boolean; meetingActive?: boolean; compact?: boolean }>) {
  const { t } = useI18n()
  const roomRef = useRef<LiveKitRoom | undefined>(undefined)
  const mediaModeRef = useRef<MediaMode | undefined>(undefined)
  const changingScreenRef = useRef(false)
  const audioElements = useRef<HTMLAudioElement[]>([])
  const [status, setStatus] = useState<'idle' | 'joining' | 'connected' | 'reconnecting' | 'error'>('idle')
  const [muted, setMuted] = useState(false)
  const [participants, setParticipants] = useState<string[]>([])
  const [activeSpeakers, setActiveSpeakers] = useState<string[]>([])
  const [sharedScreens, setSharedScreens] = useState<SharedScreen[]>([])
  const [remoteCameras, setRemoteCameras] = useState<RemoteCamera[]>([])
  const [sharingScreen, setSharingScreen] = useState(false)
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false)
  const [cameraEnabled, setCameraEnabled] = useState(false)
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
    changingScreenRef.current = false
    setParticipants([]); setActiveSpeakers([]); setSharedScreens([]); setRemoteCameras([]); setSharingScreen(false); setMicrophoneEnabled(false); setCameraEnabled(false); setMuted(false); setStatus('idle')
  }

  const addSharedScreen = (track: RemoteTrack, participantID: string, participantName: string) => {
    setSharedScreens(screens => [...screens.filter(screen => screen.id !== participantID), { id: participantID, participantName, track, isSwitching: false }])
  }
  const addRemoteCamera = (track: RemoteTrack, participantID: string, participantName: string) => setRemoteCameras(cameras => [...cameras.filter(camera => camera.id !== participantID), { id: participantID, participantName, track }])

  const syncSharedScreens = (room: LiveKitRoom) => {
    room.remoteParticipants.forEach(participant => {
      participant.trackPublications.forEach(publication => {
        const track = publication.track
        if (publication.source !== Track.Source.ScreenShare || !track || track.kind !== Track.Kind.Video) return
        addSharedScreen(track as RemoteTrack, participant.identity, participant.name || participant.identity)
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
          addSharedScreen(track as RemoteTrack, participant.identity, participant.name || participant.identity)
        }
        if (track.kind === Track.Kind.Video && publication.source === Track.Source.Camera) addRemoteCamera(track as RemoteTrack, participant.identity, participant.name || participant.identity)
      })
      room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        if (track.kind === Track.Kind.Audio) track.detach().forEach(element => element.remove())
        else track.detach()
        if (publication.source === Track.Source.ScreenShare) {
          removeSharedScreenAfterTrackChange(setSharedScreens, participant.identity, track as RemoteTrack)
        }
        if (publication.source === Track.Source.Camera) setRemoteCameras(cameras => cameras.filter(camera => camera.id !== participant.identity || camera.track !== track))
      })
      room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        const signal = screenShareSignal(payload, topic)
        if (!signal || !participant) return
        applyScreenShareSignal(setSharedScreens, participant.identity, signal)
      })
      room.on(RoomEvent.LocalTrackUnpublished, publication => {
        if (publication.source !== Track.Source.ScreenShare) return
        setSharingScreen(false)
        if (!changingScreenRef.current) publishScreenShareSignal(room, 'stopped').catch(() => undefined)
      })
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
  const toggleCamera = async () => {
    const room = roomRef.current
    if (!room) return
    setError('')
    try {
      await room.localParticipant.setCameraEnabled(!cameraEnabled)
      setCameraEnabled(value => !value)
    } catch { setError(t('rooms.cameraFailed')) }
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
      if (sharingScreen) await publishScreenShareSignal(room, 'stopped')
      await room.localParticipant.setScreenShareEnabled(!sharingScreen, { audio: false, contentHint: 'detail' })
      setSharingScreen(value => !value)
      if (sharingScreen && !microphoneEnabled) await leave()
    } catch {
      setError(t('rooms.screenShareFailed'))
    }
  }

  const changeScreenShare = async () => {
    const room = roomRef.current
    if (!room || !sharingScreen) return
    setError('')
    try {
      changingScreenRef.current = true
      await publishScreenShareSignal(room, 'switching')
      await room.localParticipant.setScreenShareEnabled(false)
      setSharingScreen(false)
      await room.localParticipant.setScreenShareEnabled(true, { audio: false, contentHint: 'detail' })
      setSharingScreen(true)
    } catch {
      await publishScreenShareSignal(room, 'stopped').catch(() => undefined)
      setError(t('rooms.screenShareFailed'))
    } finally {
      changingScreenRef.current = false
    }
  }

  useEffect(() => () => { leave().catch(() => undefined) }, [])

  const description = status === 'connected' && !microphoneEnabled && !sharingScreen ? t('rooms.screenShareReady') : t(voiceDescriptionKey(status))
  const screenShareSupported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia)
  const sectionClass = compact ? 'min-w-0' : 'mt-6 rounded-xl border border-subtle p-4'
  const titleClass = compact ? 'text-sm' : 'text-lg'
  return <section className={sectionClass} aria-label={t('rooms.meeting')}>
    <div className={compact ? 'flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between' : 'flex flex-wrap items-center justify-between gap-3'}><div className={compact ? 'min-w-0' : undefined}>{!compact && <h2 className={`flex items-center gap-2 font-semibold ${titleClass}`}><Mic size={18} /> {t('rooms.meeting')}</h2>}<p className={compact ? 'flex min-w-0 items-center gap-1 truncate text-sm text-muted' : 'mt-1 text-sm text-muted'} title={description}>{compact && <Mic className="shrink-0" size={15} />}<span className="truncate">{description}</span></p>{meetingActive && status === 'idle' && <p className="mt-1 text-sm font-medium text-emerald-700 dark:text-emerald-400">{t('rooms.meetingInProgress')}</p>}</div><MeetingControls status={status} meetingActive={meetingActive} muted={muted} cameraEnabled={cameraEnabled} compact={compact} canShareScreen={canShareScreen} screenShareSupported={screenShareSupported} sharingScreen={sharingScreen} t={t} onJoin={join} onToggleMute={toggleMute} onToggleCamera={toggleCamera} onToggleScreenShare={toggleScreenShare} onChangeScreenShare={changeScreenShare} onLeave={leave} /></div>
    {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    {status === 'connected' && <p className="mt-3 flex items-center gap-2 text-sm text-muted"><Users size={16} /> {t('rooms.voiceParticipants', { names: participants.join(', ') })}</p>}
    {status === 'connected' && activeSpeakers.length > 0 && <p className="mt-1 text-sm text-muted">{t('rooms.voiceSpeaking', { names: activeSpeakers.join(', ') })}</p>}
    {status === 'connected' && canShareScreen && !screenShareSupported && <p className="mt-3 text-sm text-muted">{t('rooms.screenShareUnsupported')}</p>}
    {sharedScreens.length > 0 && <section className="mt-4" aria-label={t('rooms.screenShares')}><h3 className="mb-2 text-sm font-semibold">{t('rooms.screenShares')}</h3><div className="grid gap-3 lg:grid-cols-2">{sharedScreens.map(sharedScreen => <SharedScreenVideo key={sharedScreen.id} sharedScreen={sharedScreen} captionsLabel={t('rooms.screenCaptions')} />)}</div></section>}
    {remoteCameras.length > 0 && <section className="mt-4" aria-label={t('rooms.cameraStreams')}><h3 className="mb-2 text-sm font-semibold">{t('rooms.cameraStreams')}</h3><div className="grid gap-3 sm:grid-cols-2">{remoteCameras.map(camera => <RemoteCameraVideo key={camera.id} camera={camera} captionsLabel={t('rooms.cameraCaptions')} />)}</div></section>}
  </section>
}
