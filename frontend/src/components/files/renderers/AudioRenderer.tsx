import { Download, Music, AlertTriangle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

interface AudioRendererProps {
  /** Authenticated preview URL */
  url: string
  fileName: string
  fileId: string
  mimeType: string
}

// Map file extensions to MIME types for cases where the stored type is wrong.
const EXT_MIME: Record<string, string> = {
  mp3:  'audio/mpeg',
  flac: 'audio/flac',
  wav:  'audio/wav',
  aac:  'audio/aac',
  m4a:  'audio/mp4',
  opus: 'audio/opus',
  ogg:  'audio/ogg',
  m4b:  'audio/mp4',
}

function resolvedMimeType(mimeType: string, fileName: string): string {
  const bad = !mimeType || mimeType === 'application/octet-stream' || mimeType === 'application/json'
  if (!bad) return mimeType
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MIME[ext] ?? mimeType
}

function browserCanPlay(mimeType: string): boolean {
  try {
    const el = document.createElement('audio')
    return el.canPlayType(mimeType) !== ''
  } catch {
    return false
  }
}

function isFlacFile(mimeType: string, fileName: string): boolean {
  return (
    mimeType === 'audio/flac' ||
    mimeType === 'audio/x-flac' ||
    fileName.toLowerCase().endsWith('.flac')
  )
}

// ── Dial ──────────────────────────────────────────────────────────────────────
// value: 0–1, label shown below, color for the active dot
interface DialProps {
  value: number
  onChange: (v: number) => void
  label: string
  color: string
}

const DOT_COUNT = 24
// Dial sweep: from -135° to +135° (270° total), 0 at bottom-left, 1 at bottom-right
const MIN_ANGLE = -135
const MAX_ANGLE = 135

function valueToAngle(v: number) {
  return MIN_ANGLE + v * (MAX_ANGLE - MIN_ANGLE)
}

function Dial({ value, onChange, label, color }: DialProps) {
  const dialRef = useRef<HTMLDivElement>(null)
  const startY = useRef<number | null>(null)
  const startVal = useRef(value)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    startY.current = e.clientY
    startVal.current = value
  }, [value])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (startY.current === null) return
    const dy = startY.current - e.clientY          // drag up = increase
    const delta = dy / 120                         // 120px = full sweep
    const next = Math.max(0, Math.min(1, startVal.current + delta))
    onChange(next)
  }, [onChange])

  const onPointerUp = useCallback(() => {
    startY.current = null
  }, [])

  const activeAngle = valueToAngle(value)

  return (
    <div className="flex flex-col items-center gap-3 select-none">
      {/* Outer ring with dots */}
      <div
        ref={dialRef}
        className="relative cursor-ns-resize"
        style={{ width: 88, height: 88 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Dots ring */}
        <svg
          viewBox="0 0 88 88"
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ transform: 'rotate(-90deg)' }}
        >
          {Array.from({ length: DOT_COUNT }, (_, i) => {
            // Distribute dots over 270° sweep (skipping bottom 90°)
            const fraction = i / (DOT_COUNT - 1)
            const angleDeg = MIN_ANGLE + fraction * (MAX_ANGLE - MIN_ANGLE)
            const angleRad = (angleDeg * Math.PI) / 180
            const r = 40
            const cx = 44 + r * Math.cos(angleRad)
            const cy = 44 + r * Math.sin(angleRad)
            const active = angleDeg <= activeAngle
            return (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={active ? 3 : 2}
                fill={active ? color : '#3a3d4a'}
                style={{ filter: active ? `drop-shadow(0 0 3px ${color})` : 'none' }}
              />
            )
          })}
        </svg>

        {/* Knob body — neumorphic dark circle */}
        <div
          className="absolute rounded-full"
          style={{
            inset: 10,
            background: '#1c1f2e',
            boxShadow: '6px 6px 14px #0d0f18, -4px -4px 10px #2b2f45',
          }}
        />

        {/* Inner indicator dot */}
        <div
          className="absolute rounded-full"
          style={{
            inset: 14,
            background: 'radial-gradient(circle at 35% 35%, #2a2d3e, #16192a)',
            boxShadow: 'inset 3px 3px 8px #0d0f18, inset -2px -2px 6px #2b2f45',
          }}
        >
          {/* Pointer dot */}
          <div
            className="absolute rounded-full"
            style={{
              width: 6,
              height: 6,
              background: color,
              boxShadow: `0 0 6px ${color}`,
              top: '50%',
              left: '50%',
              transformOrigin: '50% 50%',
              transform: `translate(-50%, -50%) rotate(${activeAngle}deg) translateY(-18px)`,
            }}
          />
        </div>
      </div>
      <span className="text-[11px] font-medium tracking-wider uppercase text-zinc-400">{label}</span>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function AudioRenderer({ url, fileName, fileId, mimeType: rawMime }: AudioRendererProps) {
  const mimeType = resolvedMimeType(rawMime, fileName)
  const flac = isFlacFile(mimeType, fileName)
  const supported = flac
    ? browserCanPlay('audio/flac') || browserCanPlay('audio/x-flac')
    : browserCanPlay(mimeType)

  const audioRef = useRef<HTMLAudioElement>(null)
  const ctxRef     = useRef<AudioContext | null>(null)
  const bassRef    = useRef<BiquadFilterNode | null>(null)
  const trebleRef  = useRef<BiquadFilterNode | null>(null)
  const gainRef    = useRef<GainNode | null>(null)
  const sourceRef  = useRef<MediaElementAudioSourceNode | null>(null)

  // 0–1 values; 0.5 = center (flat)
  const [volume,  setVolume]  = useState(0.8)
  const [bass,    setBass]    = useState(0.5)
  const [treble,  setTreble]  = useState(0.5)

  // Lazy-init Web Audio graph on first interaction to comply with autoplay policy
  const initAudio = useCallback(() => {
    if (ctxRef.current || !audioRef.current) return
    const ctx = new AudioContext()
    const source = ctx.createMediaElementSource(audioRef.current)
    const bassFilter = ctx.createBiquadFilter()
    bassFilter.type = 'lowshelf'
    bassFilter.frequency.value = 200
    const trebleFilter = ctx.createBiquadFilter()
    trebleFilter.type = 'highshelf'
    trebleFilter.frequency.value = 4000
    const gainNode = ctx.createGain()
    source.connect(bassFilter)
    bassFilter.connect(trebleFilter)
    trebleFilter.connect(gainNode)
    gainNode.connect(ctx.destination)
    ctxRef.current  = ctx
    sourceRef.current = source
    bassRef.current   = bassFilter
    trebleRef.current = trebleFilter
    gainRef.current   = gainNode
    // Apply current state
    gainNode.gain.value       = volume
    bassFilter.gain.value     = (bass   - 0.5) * 24   // ±12 dB
    trebleFilter.gain.value   = (treble - 0.5) * 24
  }, [volume, bass, treble])

  // Volume
  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = volume
    else if (audioRef.current) audioRef.current.volume = volume
  }, [volume])

  // Bass
  useEffect(() => {
    if (bassRef.current) bassRef.current.gain.value = (bass - 0.5) * 24
  }, [bass])

  // Treble
  useEffect(() => {
    if (trebleRef.current) trebleRef.current.gain.value = (treble - 0.5) * 24
  }, [treble])

  if (!supported) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-5 p-6 bg-zinc-50 dark:bg-[#0f1117]">
        <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-[#2d3148] flex items-center justify-center">
          <Music size={28} className="text-zinc-400" />
        </div>
        <div className="flex flex-col items-center gap-2 text-center max-w-xs">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <AlertTriangle size={16} />
            <span className="text-sm font-medium">Playback not supported</span>
          </div>
          <p className="text-xs text-muted">
            {flac
              ? 'Your browser cannot play FLAC audio natively.'
              : `Your browser cannot play this audio format (${mimeType || 'unknown'}).`}
          </p>
        </div>
        <a
          href={`/api/v1/files/${fileId}/download`}
          download={fileName}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors"
        >
          <Download size={14} />
          Download to play locally
        </a>
      </div>
    )
  }

  return (
    <div
      className="flex flex-col items-center justify-center h-full gap-8 p-8"
      style={{ background: '#181b28' }}
    >
      {/* Album art placeholder */}
      <div
        className="w-20 h-20 rounded-2xl flex items-center justify-center"
        style={{ background: '#1c1f2e', boxShadow: '6px 6px 14px #0d0f18, -4px -4px 10px #2b2f45' }}
      >
        <Music size={36} className="text-zinc-500" />
      </div>

      {/* File name */}
      <p className="text-sm font-medium text-zinc-300 text-center max-w-xs truncate px-4">
        {fileName}
      </p>

      {/* Three dials */}
      <div className="flex items-end gap-10">
        <Dial value={bass}    onChange={setBass}    label="Bass"    color="#22d3ee" />
        <Dial value={volume}  onChange={setVolume}  label="Volume"  color="#4ade80" />
        <Dial value={treble}  onChange={setTreble}  label="Treble"  color="#f87171" />
      </div>

      {/* Native audio element (hidden controls, we drive it via Web Audio) */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        src={url}
        controls
        className="w-full max-w-sm"
        style={{ colorScheme: 'dark' }}
        onPlay={initAudio}
      />

      <a
        href={`/api/v1/files/${fileId}/download`}
        download={fileName}
        className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <Download size={12} />
        Download
      </a>
    </div>
  )
}
