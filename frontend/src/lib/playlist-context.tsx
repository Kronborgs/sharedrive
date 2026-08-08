import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  api,
  fetchPlaylistTracks,
  updatePlaylistTracks,
  fetchPersistedPlaylistState,
  savePersistedPlaylistState,
  type PlaylistTrack,
} from '@/lib/api'

export type { PlaylistTrack }

interface PlaylistContextValue {
  // Identity
  activePlaylistId: string | null
  activePlaylistName: string | null
  setPlaylist: (id: string, name: string) => void
  clearPlaylist: () => void

  // Tracks
  tracks: PlaylistTrack[]
  isLoadingTracks: boolean

  // Playback state
  currentIndex: number
  isPlaying: boolean
  progress: number
  duration: number
  volume: number
  bass: number
  treble: number
  shuffle: boolean

  // Playback controls
  jumpTo: (i: number) => void
  togglePlay: () => void
  next: () => void
  prev: () => void
  seek: (ratio: number) => void
  setVolume: (v: number) => void
  setBass: (v: number) => void
  setTreble: (v: number) => void
  toggleShuffle: () => void

  // Playlist track management
  removeTrack: (trackId: string) => Promise<void>
  addTracks: (fileIds: string[]) => Promise<{ added: number; skipped: number }>

  // Config
  playlistMaxTracks: number
}

// ── Local cache — same-device instant hydration ───────────────────────────────
const STORAGE_KEY = 'sharedrive_playlist'
type Cached = { id: string; name: string; index: number; vol: number; shuffle: boolean }

function secureRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) return 0
  if (!globalThis.crypto?.getRandomValues) return 0

  // Rejection sampling keeps index distribution uniform.
  const maxUint32 = 0x100000000
  const limit = Math.floor(maxUint32 / maxExclusive) * maxExclusive
  const buf = new Uint32Array(1)

  do {
    globalThis.crypto.getRandomValues(buf)
  } while (buf[0] >= limit)

  return buf[0] % maxExclusive
}

function loadCache(): Cached | null {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Cached } catch { return null }
}
function saveCache(p: Cached | null) {
  try {
    if (p) localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
    else localStorage.removeItem(STORAGE_KEY)
  } catch { /* ignore */ }
}

const PlaylistContext = createContext<PlaylistContextValue | null>(null)

function setMediaPlaybackState(state: MediaSessionPlaybackState) {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.playbackState = state
}

function updateMediaMetadata(track: PlaylistTrack | undefined, playlistName: string | null) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return
  navigator.mediaSession.metadata = track
    ? new MediaMetadata({ title: track.name, album: playlistName ?? undefined })
    : null
}

function updateMediaPosition(audio: HTMLAudioElement) {
  if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return
  const duration = audio.duration
  const position = audio.currentTime
  const playbackRate = audio.playbackRate
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position) || !Number.isFinite(playbackRate) || playbackRate <= 0) return

  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate,
      position: Math.min(Math.max(position, 0), duration),
    })
  } catch (error) {
    console.warn('[playlist] Media Session position unavailable', error)
  }
}

export function PlaylistProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(() => loadCache()?.id ?? null)
  const [activePlaylistName, setActivePlaylistName] = useState<string | null>(() => loadCache()?.name ?? null)
  const [tracks, setTracks]                         = useState<PlaylistTrack[]>([])
  const [isLoadingTracks, setIsLoadingTracks]       = useState(false)
  const [currentIndex, setCurrentIndex]             = useState(0)
  const [isPlaying, setIsPlaying]                   = useState(false)
  const [progress, setProgress]                     = useState(0)
  const [duration, setDuration]                     = useState(0)
  const [volumeLevel, setVolumeLevel]              = useState(() => loadCache()?.vol ?? 1)
  const [bassLevel, setBassLevel]                  = useState(0)
  const [trebleLevel, setTrebleLevel]              = useState(0)
  const [shuffleEnabled, setShuffleEnabled]        = useState(() => loadCache()?.shuffle ?? false)

  // Web Audio refs — lazily initialised on first play
  const audioCtxRef    = useRef<AudioContext | null>(null)
  const bassFilterRef  = useRef<BiquadFilterNode | null>(null)
  const trebleFilterRef = useRef<BiquadFilterNode | null>(null)
  const bassValRef     = useRef(0)
  const trebleValRef   = useRef(0)

  const { data: publicSettings } = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: ({ signal }) => api.get<{ playlist_max_tracks?: number }>('/api/v1/system/settings', signal),
    staleTime: 5 * 60_000,
  })
  const playlistMaxTracks = publicSettings?.playlist_max_tracks ?? 200

  // Refs so audio event closures always read the latest values without stale closures
  const shuffleRef      = useRef(loadCache()?.shuffle ?? false)
  const tracksRef       = useRef<PlaylistTrack[]>([])
  const currentIndexRef = useRef(0)
  const playlistNameRef = useRef(activePlaylistName)
  useEffect(() => { shuffleRef.current = shuffleEnabled }, [shuffleEnabled])
  useEffect(() => { tracksRef.current = tracks }, [tracks])
  useEffect(() => { currentIndexRef.current = currentIndex }, [currentIndex])
  useEffect(() => { playlistNameRef.current = activePlaylistName }, [activePlaylistName])

  // Index to restore when tracks first load (from cache or server state)
  const pendingIndexRef = useRef(loadCache()?.index ?? 0)

  // Persistent audio element
  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (!audioRef.current) {
    audioRef.current = new Audio()
    audioRef.current.preload = 'auto'
    audioRef.current.volume = loadCache()?.vol ?? 1
  }

  const prevIndexRef = useRef(-1)
  const isChangingTrackRef = useRef(false)
  const playbackRequestRef = useRef(0)

  const ensureWebAudio = useCallback(() => {
    if (audioCtxRef.current) return audioCtxRef.current

    const ctx = new AudioContext()
    const source = ctx.createMediaElementSource(audioRef.current!)
    const bassFilter = ctx.createBiquadFilter()
    bassFilter.type = 'lowshelf'
    bassFilter.frequency.value = 200
    bassFilter.gain.value = bassValRef.current
    const trebleFilter = ctx.createBiquadFilter()
    trebleFilter.type = 'highshelf'
    trebleFilter.frequency.value = 4000
    trebleFilter.gain.value = trebleValRef.current
    source.connect(bassFilter)
    bassFilter.connect(trebleFilter)
    trebleFilter.connect(ctx.destination)
    audioCtxRef.current = ctx
    bassFilterRef.current = bassFilter
    trebleFilterRef.current = trebleFilter
    return ctx
  }, [])

  const startPlayback = useCallback(async () => {
    const audio = audioRef.current!
    const audioContext = audioCtxRef.current
    if (audioContext && audioContext.state !== 'running') {
      console.info('[playlist] Requesting AudioContext resume', { state: audioContext.state, visibility: document.visibilityState })
      try {
        await audioContext.resume()
      } catch (error) {
        console.error('[playlist] AudioContext resume failed', { state: audioContext.state, error })
      }
    }

    try {
      await audio.play()
      return true
    } catch (error) {
      audio.autoplay = false
      setIsPlaying(false)
      setMediaPlaybackState(tracksRef.current.length > 0 ? 'paused' : 'none')
      console.error('[playlist] audio.play() rejected', {
        index: currentIndexRef.current,
        src: audio.currentSrc || audio.src,
        visibility: document.visibilityState,
        error,
      })
      return false
    }
  }, [])

  const playTrackAtIndex = useCallback(async (index: number) => {
    const track = tracksRef.current[index]
    if (!track) return

    const request = ++playbackRequestRef.current
    const audio = audioRef.current!
    prevIndexRef.current = index
    currentIndexRef.current = index
    isChangingTrackRef.current = true
    audio.autoplay = true
    audio.src = track.preview_url
    audio.load()
    updateMediaMetadata(track, playlistNameRef.current)
    setProgress(0)
    setDuration(0)
    setCurrentIndex(index)

    const started = await startPlayback()
    if (request !== playbackRequestRef.current) return
    isChangingTrackRef.current = false
    if (started) {
      console.info('[playlist] Track started', { index, src: audio.currentSrc || audio.src })
    }
  }, [startPlayback])

  // ── On mount: fetch authoritative state from server (cross-device sync) ──────
  useEffect(() => {
    fetchPersistedPlaylistState()
      .then(state => {
        if (!state) return
        // Update pending index so it's applied when tracks load
        pendingIndexRef.current = state.index
        // setActivePlaylistId is a no-op if the value hasn't changed (React bails out)
        setActivePlaylistId(state.id)
        setActivePlaylistName(state.name)
        setVolumeLevel(state.vol)
        audioRef.current!.volume = state.vol
        setShuffleEnabled(state.shuffle)
        shuffleRef.current = state.shuffle
      })
      .catch(() => { /* server unavailable — local cache is fine */ })
  }, [])

  // Wire audio events once on mount
  useEffect(() => {
    const audio = audioRef.current!
    const onTime  = () => {
      setProgress(audio.currentTime)
      updateMediaPosition(audio)
    }
    const onDur   = () => {
      setDuration(audio.duration)
      updateMediaPosition(audio)
    }
    const onPlay  = () => {
      isChangingTrackRef.current = false
      audio.autoplay = true
      const audioContext = audioCtxRef.current
      if (audioContext && audioContext.state !== 'running') {
        audioContext.resume().catch(error => {
          console.error('[playlist] AudioContext resume failed during play', { state: audioContext.state, error })
        })
      }
      setIsPlaying(true)
      setMediaPlaybackState('playing')
      updateMediaPosition(audio)
    }
    const onPause = () => {
      if (!audio.ended && !isChangingTrackRef.current) {
        audio.autoplay = false
        setIsPlaying(false)
        setMediaPlaybackState(tracksRef.current.length > 0 ? 'paused' : 'none')
      }
    }
    const onEnded = () => {
      const len = tracksRef.current.length
      if (len === 0) {
        setIsPlaying(false)
        return
      }

      const current = currentIndexRef.current
      let next: number | null = null

      if (shuffleRef.current) {
        if (len > 1) {
          next = secureRandomInt(len - 1)
          if (next >= current) next += 1
        }
      } else if (current < len - 1) {
        next = current + 1
      }

      console.info('[playlist] Track ended', {
        currentIndex: current,
        nextIndex: next,
        visibility: document.visibilityState,
        audioContextState: audioCtxRef.current?.state ?? 'not-initialized',
      })

      if (next === null) {
        audio.autoplay = false
        setIsPlaying(false)
        setMediaPlaybackState('paused')
        return
      }
      playTrackAtIndex(next).catch(error => {
        console.error('[playlist] Failed to advance after track ended', { nextIndex: next, error })
      })
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('durationchange', onDur)
    audio.addEventListener('ratechange', onDur)
    audio.addEventListener('play',  onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('durationchange', onDur)
      audio.removeEventListener('ratechange', onDur)
      audio.removeEventListener('play',  onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
    }
  }, [playTrackAtIndex])

  // Fetch tracks when playlist changes
  useEffect(() => {
    if (!activePlaylistId) {
      setTracks([])
      setCurrentIndex(0)
      audioRef.current!.pause()
      audioRef.current!.src = ''
      setIsPlaying(false)
      setProgress(0)
      setDuration(0)
      return
    }
    setIsLoadingTracks(true)
    fetchPlaylistTracks(activePlaylistId)
      .then(t => {
        const start = pendingIndexRef.current < t.length ? pendingIndexRef.current : 0
        pendingIndexRef.current = 0
        tracksRef.current = t
        currentIndexRef.current = start
        setTracks(t)
        setCurrentIndex(start)
        setProgress(0)
        setDuration(0)
        if (t.length > 0) {
          audioRef.current!.src = t[start].preview_url
          audioRef.current!.load()
        }
      })
      .catch(() => setTracks([]))
      .finally(() => setIsLoadingTracks(false))
  }, [activePlaylistId])

  // Keep the media source synchronized for non-playback changes such as track removal.
  useEffect(() => {
    if (tracks.length === 0) return
    if (currentIndex < 0 || currentIndex >= tracks.length) return
    if (prevIndexRef.current === currentIndex) return
    prevIndexRef.current = currentIndex

    const audio = audioRef.current!
    audio.src = tracks[currentIndex].preview_url
    audio.load()
    setProgress(0)
    setDuration(0)
  }, [currentIndex, tracks])

  // ── Persist state — local cache (instant) + server (debounced, cross-device) ─
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    if (activePlaylistId) {
      const p = { id: activePlaylistId, name: activePlaylistName ?? '', index: currentIndex, vol: volumeLevel, shuffle: shuffleEnabled }
      saveCache(p)
      saveTimerRef.current = setTimeout(() => {
  		savePersistedPlaylistState(p).catch(() => { /* ignore */ })
      }, 2000)
    } else {
      saveCache(null)
      saveTimerRef.current = setTimeout(() => {
  		savePersistedPlaylistState(null).catch(() => { /* ignore */ })
      }, 500)
    }
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [activePlaylistId, activePlaylistName, currentIndex, volumeLevel, shuffleEnabled])

  // ── Controls ──────────────────────────────────────────────────────────────────

  const jumpTo = useCallback((i: number) => {
    void playTrackAtIndex(i)
  }, [playTrackAtIndex])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current!
    if (audio.paused) {
      void startPlayback()
    } else {
      audio.pause()
    }
  }, [startPlayback])

  const next = useCallback(() => {
    const current = currentIndexRef.current
    const len = tracksRef.current.length
    if (shuffleRef.current) {
      if (len <= 1) return
      let nextIndex = secureRandomInt(len - 1)
      if (nextIndex >= current) nextIndex += 1
      void playTrackAtIndex(nextIndex)
      return
    }
    if (current < len - 1) void playTrackAtIndex(current + 1)
  }, [playTrackAtIndex])

  const prev = useCallback(() => {
    const audio = audioRef.current!
    if (audio.currentTime > 3) {
      audio.currentTime = 0
      return
    }
    const current = currentIndexRef.current
    if (current > 0) void playTrackAtIndex(current - 1)
  }, [playTrackAtIndex])

  const seekToTime = useCallback((time: number) => {
    const audio = audioRef.current!
    if (!Number.isFinite(time) || !Number.isFinite(audio.duration) || audio.duration <= 0) return
    audio.currentTime = Math.min(Math.max(time, 0), audio.duration)
    updateMediaPosition(audio)
  }, [])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return

    const setHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler)
      } catch (error) {
        console.warn('[playlist] Media Session action unavailable', { action, error })
      }
    }
    setHandler('play', () => { if (audioRef.current!.paused) void startPlayback() })
    setHandler('pause', () => { if (!audioRef.current!.paused) audioRef.current!.pause() })
    setHandler('nexttrack', next)
    setHandler('previoustrack', prev)
    setHandler('seekto', details => {
      if (details.seekTime !== undefined) seekToTime(details.seekTime)
    })
    setHandler('seekbackward', details => seekToTime(audioRef.current!.currentTime - (details.seekOffset ?? 10)))
    setHandler('seekforward', details => seekToTime(audioRef.current!.currentTime + (details.seekOffset ?? 10)))

    return () => {
      setHandler('play', null)
      setHandler('pause', null)
      setHandler('nexttrack', null)
      setHandler('previoustrack', null)
      setHandler('seekto', null)
      setHandler('seekbackward', null)
      setHandler('seekforward', null)
    }
  }, [next, prev, seekToTime, startPlayback])

  useEffect(() => {
    const track = tracks[currentIndex]
    updateMediaMetadata(track, activePlaylistName)
    if (!track) setMediaPlaybackState('none')
  }, [activePlaylistName, currentIndex, tracks])

  const seek = useCallback((ratio: number) => {
    const audio = audioRef.current!
    seekToTime(ratio * audio.duration)
  }, [seekToTime])

  const setVolume = useCallback((v: number) => {
    audioRef.current!.volume = v
    setVolumeLevel(v)
  }, [])

  const setBass = useCallback((v: number) => {
    bassValRef.current = v
    if (v !== 0 || audioCtxRef.current) {
      const audioContext = ensureWebAudio()
      bassFilterRef.current!.gain.value = v
      if (audioContext.state !== 'running') {
        audioContext.resume().catch(error => console.error('[playlist] AudioContext resume failed after bass change', error))
      }
    }
    setBassLevel(v)
  }, [ensureWebAudio])

  const setTreble = useCallback((v: number) => {
    trebleValRef.current = v
    if (v !== 0 || audioCtxRef.current) {
      const audioContext = ensureWebAudio()
      trebleFilterRef.current!.gain.value = v
      if (audioContext.state !== 'running') {
        audioContext.resume().catch(error => console.error('[playlist] AudioContext resume failed after treble change', error))
      }
    }
    setTrebleLevel(v)
  }, [ensureWebAudio])

  const toggleShuffle = useCallback(() => {
    setShuffleEnabled(v => {
      shuffleRef.current = !v
      return !v
    })
  }, [])

  const removeTrack = useCallback(async (trackId: string) => {
    if (!activePlaylistId) return
    const newTracks = tracks.filter(t => t.id !== trackId)
    if (newTracks.length === 0) return
    await updatePlaylistTracks(activePlaylistId, newTracks.map(t => t.id))
    const removedIdx = tracks.findIndex(t => t.id === trackId)
    setTracks(newTracks)
    setCurrentIndex(ci => {
      if (removedIdx < ci) return ci - 1
      if (removedIdx === ci) {
        prevIndexRef.current = -1
        return Math.min(ci, newTracks.length - 1)
      }
      return ci
    })
  }, [activePlaylistId, tracks])

  const addTracks = useCallback(async (fileIds: string[]) => {
    if (!activePlaylistId) return { added: 0, skipped: 0 }
    const existing = new Set(tracks.map(t => t.id))
    const toAdd = fileIds.filter(id => !existing.has(id))
    const available = playlistMaxTracks - tracks.length
    const adding = toAdd.slice(0, available)
    const skipped = fileIds.length - adding.length
    if (adding.length === 0) return { added: 0, skipped }

    const newIds = [...tracks.map(t => t.id), ...adding]
    await updatePlaylistTracks(activePlaylistId, newIds)
    const fresh = await fetchPlaylistTracks(activePlaylistId)
    setTracks(fresh)
    return { added: adding.length, skipped }
  }, [activePlaylistId, tracks, playlistMaxTracks])

  const setPlaylist = useCallback((id: string, name: string) => {
    pendingIndexRef.current = 0
    setActivePlaylistId(id)
    setActivePlaylistName(name)
    prevIndexRef.current = -1
  }, [])

  const clearPlaylist = useCallback(() => {
    audioRef.current!.pause()
    setActivePlaylistId(null)
    setActivePlaylistName(null)
  }, [])

  const value = useMemo(() => ({
    activePlaylistId,
    activePlaylistName,
    tracks,
    isLoadingTracks,
    currentIndex,
    isPlaying,
    progress,
    duration,
    volume: volumeLevel,
    bass: bassLevel,
    treble: trebleLevel,
    shuffle: shuffleEnabled,
    setPlaylist,
    clearPlaylist,
    jumpTo,
    togglePlay,
    next,
    prev,
    seek,
    setVolume,
    setBass,
    setTreble,
    toggleShuffle,
    removeTrack,
    addTracks,
    playlistMaxTracks,
  }), [
    activePlaylistId,
    activePlaylistName,
    tracks,
    isLoadingTracks,
    currentIndex,
    isPlaying,
    progress,
    duration,
    volumeLevel,
    bassLevel,
    trebleLevel,
    shuffleEnabled,
    setPlaylist,
    clearPlaylist,
    jumpTo,
    togglePlay,
    next,
    prev,
    seek,
    setVolume,
    setBass,
    setTreble,
    toggleShuffle,
    removeTrack,
    addTracks,
    playlistMaxTracks,
  ])

  return (
    <PlaylistContext.Provider value={value}>
      {children}
    </PlaylistContext.Provider>
  )
}

export function usePlaylist() {
  const ctx = useContext(PlaylistContext)
  if (!ctx) throw new Error('usePlaylist must be used within PlaylistProvider')
  return ctx
}

