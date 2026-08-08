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
  useEffect(() => { shuffleRef.current = shuffleEnabled }, [shuffleEnabled])
  useEffect(() => { tracksRef.current = tracks }, [tracks])
  useEffect(() => { currentIndexRef.current = currentIndex }, [currentIndex])

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

  const playTrackAtIndex = useCallback(async (index: number) => {
    const track = tracksRef.current[index]
    if (!track) return

    const audio = audioRef.current!
    prevIndexRef.current = index
    currentIndexRef.current = index
    audio.src = track.preview_url
    audio.load()
    setProgress(0)
    setDuration(0)
    setCurrentIndex(index)

    const audioContext = audioCtxRef.current
    if (audioContext?.state === 'suspended') {
      console.info('[playlist] Resuming AudioContext', { visibility: document.visibilityState })
      try {
        await audioContext.resume()
      } catch (error) {
        console.error('[playlist] AudioContext resume failed', { state: audioContext.state, error })
      }
    }

    try {
      await audio.play()
      console.info('[playlist] Next track started', { index, src: audio.currentSrc || audio.src })
    } catch (error) {
      setIsPlaying(false)
      console.error('[playlist] audio.play() rejected', {
        index,
        src: audio.currentSrc || audio.src,
        visibility: document.visibilityState,
        error,
      })
    }
  }, [])

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Wire audio events once on mount
  useEffect(() => {
    const audio = audioRef.current!
    const onTime  = () => setProgress(audio.currentTime)
    const onDur   = () => setDuration(audio.duration)
    const initWebAudio = () => {
      if (audioCtxRef.current) { audioCtxRef.current.resume().catch(() => undefined); return }
      const ctx = new AudioContext()
      const source = ctx.createMediaElementSource(audio)
      const bassF = ctx.createBiquadFilter()
      bassF.type = 'lowshelf'
      bassF.frequency.value = 200
      bassF.gain.value = bassValRef.current
      const trebleF = ctx.createBiquadFilter()
      trebleF.type = 'highshelf'
      trebleF.frequency.value = 4000
      trebleF.gain.value = trebleValRef.current
      source.connect(bassF)
      bassF.connect(trebleF)
      trebleF.connect(ctx.destination)
      audioCtxRef.current   = ctx
      bassFilterRef.current  = bassF
      trebleFilterRef.current = trebleF
    }
    const onPlay  = () => {
      initWebAudio()
      setIsPlaying(true)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
    }
    const onPause = () => {
      if (!audio.ended) {
        setIsPlaying(false)
      }
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
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
        setIsPlaying(false)
        return
      }
      playTrackAtIndex(next).catch(error => {
        console.error('[playlist] Failed to advance after track ended', { nextIndex: next, error })
      })
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('durationchange', onDur)
    audio.addEventListener('play',  onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('durationchange', onDur)
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

  // Load new src when currentIndex changes (but only after tracks are loaded)
  useEffect(() => {
    if (tracks.length === 0) return
    if (currentIndex < 0 || currentIndex >= tracks.length) return
    if (prevIndexRef.current === currentIndex) return
    prevIndexRef.current = currentIndex

    const audio = audioRef.current!
    const shouldAutoPlay = isPlaying
    audio.src = tracks[currentIndex].preview_url
    audio.load()
    setProgress(0)
    setDuration(0)
    if (shouldAutoPlay) {
      audio.play().catch(() => setIsPlaying(false))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    prevIndexRef.current = -1
    setCurrentIndex(i)
    setIsPlaying(true)
  }, [])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current!
    if (audio.paused) {
      audio.play().catch(() => setIsPlaying(false))
    } else {
      audio.pause()
    }
  }, [])

  const next = useCallback(() => {
    setCurrentIndex(i => {
      const len = tracksRef.current.length
      if (shuffleRef.current) {
        if (len <= 1) return i
        let n = secureRandomInt(len - 1)
        if (n >= i) n += 1
        prevIndexRef.current = -1
        return n
      }
      if (i >= len - 1) return i
      prevIndexRef.current = -1
      return i + 1
    })
    setIsPlaying(true)
  }, [])

  const prev = useCallback(() => {
    const audio = audioRef.current!
    if (audio.currentTime > 3) {
      audio.currentTime = 0
      return
    }
    setCurrentIndex(i => {
      if (i <= 0) return i
      prevIndexRef.current = -1
      return i - 1
    })
    setIsPlaying(true)
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
    setHandler('play', () => { if (audioRef.current!.paused) togglePlay() })
    setHandler('pause', () => { if (!audioRef.current!.paused) togglePlay() })
    setHandler('nexttrack', next)
    setHandler('previoustrack', prev)

    return () => {
      setHandler('play', null)
      setHandler('pause', null)
      setHandler('nexttrack', null)
      setHandler('previoustrack', null)
    }
  }, [next, prev, togglePlay])

  useEffect(() => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return
    const track = tracks[currentIndex]
    navigator.mediaSession.metadata = track
      ? new MediaMetadata({ title: track.name, album: activePlaylistName ?? undefined })
      : null
  }, [activePlaylistName, currentIndex, tracks])

  const seek = useCallback((ratio: number) => {
    const audio = audioRef.current!
    if (audio.duration) audio.currentTime = ratio * audio.duration
  }, [])

  const setVolume = useCallback((v: number) => {
    audioRef.current!.volume = v
    setVolumeLevel(v)
  }, [])

  const setBass = useCallback((v: number) => {
    bassValRef.current = v
    if (bassFilterRef.current) bassFilterRef.current.gain.value = v
    setBassLevel(v)
  }, [])

  const setTreble = useCallback((v: number) => {
    trebleValRef.current = v
    if (trebleFilterRef.current) trebleFilterRef.current.gain.value = v
    setTrebleLevel(v)
  }, [])

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

