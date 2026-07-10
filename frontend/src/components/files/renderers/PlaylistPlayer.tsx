import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchPlaylistTracks } from '@/lib/api'
import type { PlaylistTrack } from '@/lib/api'
import {
  Music,
  Loader2,
  AlertTriangle,
  Volume2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { RetroButton } from '@/components/files/Dial'

interface PlaylistPlayerProps {
  fileId: string
}

function secureRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) return 0
  if (!globalThis.crypto?.getRandomValues) return 0

  // Rejection sampling avoids modulo bias for uniform index selection.
  const maxUint32 = 0x100000000
  const limit = Math.floor(maxUint32 / maxExclusive) * maxExclusive
  const buf = new Uint32Array(1)

  do {
    globalThis.crypto.getRandomValues(buf)
  } while (buf[0] >= limit)

  return buf[0] % maxExclusive
}

export function PlaylistPlayer({ fileId }: PlaylistPlayerProps) {
  const { data: tracks, isLoading, isError } = useQuery({
    queryKey: ['playlist-tracks', fileId],
    queryFn: () => fetchPlaylistTracks(fileId),
    staleTime: 30_000,
    retry: 1,
  })

  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [shuffle, setShuffle] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const current: PlaylistTrack | undefined = tracks?.[currentIndex]

  // When track changes, reset and optionally auto-play
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !current) return
    const wasPlaying = isPlaying
    audio.src = current.preview_url
    audio.load()
    if (wasPlaying) {
      void audio.play().catch(() => setIsPlaying(false))
    }
    setProgress(0)
    setDuration(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, current?.preview_url])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => setProgress(audio.currentTime)
    const onDur = () => setDuration(audio.duration)
    const onEnded = () => {
      if (!tracks) return
      if (shuffle) {
        if (tracks.length <= 1) {
          setIsPlaying(false)
          setProgress(0)
          return
        }
        setCurrentIndex(i => {
          let next = secureRandomInt(tracks.length - 1)
          if (next >= i) next += 1
          return next
        })
      } else if (currentIndex < tracks.length - 1) {
        setCurrentIndex(i => i + 1)
      } else {
        setIsPlaying(false)
        setProgress(0)
      }
    }
    const onPlay = () => setIsPlaying(true)
    const onPause = () => { if (!audio.ended) setIsPlaying(false) }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('durationchange', onDur)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('durationchange', onDur)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
    }
  }, [currentIndex, tracks, shuffle])

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio || !current) return
    if (audio.paused) {
      void audio.play().catch(() => setIsPlaying(false))
    } else {
      audio.pause()
    }
  }

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current
    if (!audio || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    audio.currentTime = ratio * duration
  }

  const fmt = (s: number) => {
    if (!isFinite(s)) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={28} className="animate-spin text-brand-500" />
      </div>
    )
  }

  if (isError || !tracks) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted">
        <AlertTriangle size={32} className="text-zinc-300 dark:text-slate-600" />
        <p className="text-sm">Could not load playlist tracks.</p>
      </div>
    )
  }

  if (tracks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted">
        <Music size={32} className="text-zinc-300 dark:text-slate-600" />
        <p className="text-sm">This playlist is empty or all tracks are inaccessible.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} preload="auto" />

      {/* Track list */}
      <div className="flex-1 overflow-y-auto divide-y divide-zinc-100 dark:divide-[#2d3148]">
        {tracks.map((track, i) => (
          <button
            key={track.id}
            onClick={() => {
              if (i === currentIndex) {
                togglePlay()
              } else {
                setCurrentIndex(i)
                setIsPlaying(true)
              }
            }}
            className={cn(
              'w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors',
              i === currentIndex && 'bg-brand-50 dark:bg-brand-900/20'
            )}
          >
            <div className="w-7 h-7 flex items-center justify-center shrink-0 rounded-full bg-zinc-100 dark:bg-[#2d3148]">
              {i === currentIndex && isPlaying
                ? <Volume2 size={13} className="text-brand-500" />
                : <span className="text-xs text-zinc-500 dark:text-slate-400">{i + 1}</span>
              }
            </div>
            <span className={cn(
              'flex-1 text-sm truncate',
              i === currentIndex
                ? 'font-medium text-brand-600 dark:text-brand-400'
                : 'text-zinc-800 dark:text-slate-200'
            )}>
              {track.name}
            </span>
          </button>
        ))}
      </div>

      {/* Player controls */}
      <div className="shrink-0 border-t border-zinc-200 dark:border-[#2d3148] px-4 py-3" style={{ background: '#181b28' }}>
        <p className="text-xs font-medium text-zinc-400 dark:text-slate-400 truncate mb-2">
          {current?.name ?? 'No track selected'}
        </p>

        {/* Progress bar */}
        <div
          className="w-full h-1.5 bg-zinc-700 rounded-full cursor-pointer mb-3"
          onClick={seek}
        >
          <div
            className="h-full bg-brand-500 rounded-full transition-all"
            style={{ width: duration ? `${(progress / duration) * 100}%` : '0%' }}
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] text-zinc-500 tabular-nums w-8">{fmt(progress)}</span>

          <div className="flex items-center gap-2.5">
            <RetroButton
              onClick={() => setShuffle(v => !v)}
              active={shuffle}
              color="#a78bfa"
              icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/></svg>}
              label={shuffle ? 'Shuffle til' : 'Shuffle fra'}
              size={30}
            />

            <RetroButton
              onClick={() => setCurrentIndex(i => Math.max(0, i - 1))}
              disabled={currentIndex === 0}
              icon={<svg width="13" height="13" viewBox="0 0 10 10" fill="currentColor"><rect x="0" y="1" width="2" height="8"/><polygon points="8,1 2,5 8,9"/></svg>}
              label="Forrige"
              size={30}
            />

            <RetroButton
              onClick={togglePlay}
              disabled={!current}
              active={isPlaying}
              color="#4ade80"
              icon={isPlaying
                ? <svg width="13" height="13" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="3" height="8"/><rect x="6" y="1" width="3" height="8"/></svg>
                : <svg width="13" height="13" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg>}
              label={isPlaying ? 'Pause' : 'Afspil'}
              size={38}
            />

            <RetroButton
              onClick={() => {
                if (shuffle && tracks && tracks.length > 1) {
                  setCurrentIndex(i => {
                    let next = secureRandomInt(tracks.length - 1)
                    if (next >= i) next += 1
                    return next
                  })
                } else {
                  setCurrentIndex(i => Math.min((tracks?.length ?? 1) - 1, i + 1))
                }
              }}
              disabled={!shuffle && currentIndex >= (tracks?.length ?? 1) - 1}
              icon={<svg width="13" height="13" viewBox="0 0 10 10" fill="currentColor"><rect x="8" y="1" width="2" height="8"/><polygon points="2,1 8,5 2,9"/></svg>}
              label="Næste"
              size={30}
            />
          </div>

          <span className="text-[10px] text-zinc-500 tabular-nums w-8 text-right">{fmt(duration)}</span>
        </div>
      </div>
    </div>
  )
}
