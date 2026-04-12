import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { fetchPlaylistTracks, updatePlaylistTracks } from '@/lib/api'
import type { PlaylistTrack } from '@/lib/api'

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

  // Playback controls
  jumpTo: (i: number) => void
  togglePlay: () => void
  next: () => void
  prev: () => void
  seek: (ratio: number) => void
  setVolume: (v: number) => void

  // Playlist track management
  removeTrack: (trackId: string) => Promise<void>
  addTracks: (fileIds: string[]) => Promise<{ added: number; skipped: number }>
}

const STORAGE_KEY = 'sharedrive_playlist'
type Persisted = { id: string; name: string; index: number; vol: number }
function loadPersisted(): Persisted | null {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Persisted } catch { return null }
}
function savePersisted(p: Persisted | null) {
  try {
    if (p) localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
    else localStorage.removeItem(STORAGE_KEY)
  } catch { /* ignore */ }
}

const PlaylistContext = createContext<PlaylistContextValue | null>(null)

export function PlaylistProvider({ children }: { children: ReactNode }) {
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(() => loadPersisted()?.id ?? null)
  const [activePlaylistName, setActivePlaylistName] = useState<string | null>(() => loadPersisted()?.name ?? null)
  const [tracks, setTracks] = useState<PlaylistTrack[]>([])
  const [isLoadingTracks, setIsLoadingTracks] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(() => loadPersisted()?.vol ?? 1)

  // Persistent audio element — never removed from memory
  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (!audioRef.current) {
    audioRef.current = new Audio()
    audioRef.current.preload = 'auto'
    audioRef.current.volume = loadPersisted()?.vol ?? 1
  }

  // Wire audio events once on mount
  useEffect(() => {
    const audio = audioRef.current!
    const onTime  = () => setProgress(audio.currentTime)
    const onDur   = () => setDuration(audio.duration)
    const onPlay  = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onEnded = () => {
      setCurrentIndex(i => {
        const next = i + 1
        return next  // Effect below handles advancing
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
  }, [])

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
        pendingIndexRef.current = 0  // reset so future playlist changes start from 0
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
  const prevIndexRef = useRef(-1)
  // Index to restore when tracks first load after a page refresh
  const pendingIndexRef = useRef(loadPersisted()?.index ?? 0)
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
      void audio.play().catch(() => setIsPlaying(false))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, tracks])

  const jumpTo = useCallback((i: number) => {
    prevIndexRef.current = -1 // force reload
    setCurrentIndex(i)
    setIsPlaying(true)
  }, [])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current!
    if (audio.paused) {
      void audio.play().catch(() => setIsPlaying(false))
    } else {
      audio.pause()
    }
  }, [])

  const next = useCallback(() => {
    setCurrentIndex(i => {
      if (i >= tracks.length - 1) return i
      prevIndexRef.current = -1
      return i + 1
    })
    setIsPlaying(true)
  }, [tracks.length])

  const prev = useCallback(() => {
    const audio = audioRef.current!
    // If >3 s in, restart current track; otherwise go to previous
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

  const seek = useCallback((ratio: number) => {
    const audio = audioRef.current!
    if (audio.duration) audio.currentTime = ratio * audio.duration
  }, [])

  const setVolume = useCallback((v: number) => {
    audioRef.current!.volume = v
    setVolumeState(v)
  }, [])

  const removeTrack = useCallback(async (trackId: string) => {
    if (!activePlaylistId) return
    const newTracks = tracks.filter(t => t.id !== trackId)
    if (newTracks.length === 0) return // don't allow emptying playlist
    await updatePlaylistTracks(activePlaylistId, newTracks.map(t => t.id))
    const removedIdx = tracks.findIndex(t => t.id === trackId)
    setTracks(newTracks)
    // Adjust current index
    setCurrentIndex(ci => {
      if (removedIdx < ci) return ci - 1
      if (removedIdx === ci) {
        // was playing removed track — restart from same position
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
    const available = 50 - tracks.length
    const adding = toAdd.slice(0, available)
    const skipped = fileIds.length - adding.length
    if (adding.length === 0) return { added: 0, skipped }

    const newIds = [...tracks.map(t => t.id), ...adding]
    await updatePlaylistTracks(activePlaylistId, newIds)
    // Fetch fresh track metadata
    const fresh = await fetchPlaylistTracks(activePlaylistId)
    setTracks(fresh)
    return { added: adding.length, skipped }
  }, [activePlaylistId, tracks])

  const setPlaylist = useCallback((id: string, name: string) => {
    pendingIndexRef.current = 0  // new explicit playlist always starts from beginning
    setActivePlaylistId(id)
    setActivePlaylistName(name)
    prevIndexRef.current = -1
  }, [])

  const clearPlaylist = useCallback(() => {
    audioRef.current!.pause()
    setActivePlaylistId(null)
    setActivePlaylistName(null)
  }, [])

  // Persist key state to localStorage so it survives hard refresh / Docker restart
  useEffect(() => {
    if (activePlaylistId) {
      savePersisted({ id: activePlaylistId, name: activePlaylistName ?? '', index: currentIndex, vol: volume })
    } else {
      savePersisted(null)
    }
  }, [activePlaylistId, activePlaylistName, currentIndex, volume])

  return (
    <PlaylistContext.Provider
      value={{
        activePlaylistId,
        activePlaylistName,
        tracks,
        isLoadingTracks,
        currentIndex,
        isPlaying,
        progress,
        duration,
        volume,
        setPlaylist,
        clearPlaylist,
        jumpTo,
        togglePlay,
        next,
        prev,
        seek,
        setVolume,
        removeTrack,
        addTracks,
      }}
    >
      {children}
    </PlaylistContext.Provider>
  )
}

export function usePlaylist() {
  const ctx = useContext(PlaylistContext)
  if (!ctx) throw new Error('usePlaylist must be used within PlaylistProvider')
  return ctx
}
