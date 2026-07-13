import { useEffect, useRef, useState } from 'react'

// ── Cassette tape icon (retro media player icon) ──────────────────────────────
export function CassetteIcon({ size = 12, className = '' }: { size?: number; className?: string }) {
  const s = size
  return (
    <svg
      width={s}
      height={Math.round(s * 0.72)}
      viewBox="0 0 14 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="0.95"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="0.5" y="0.5" width="13" height="9" rx="1.2" />
      <circle cx="4"  cy="4.5" r="1.7" />
      <circle cx="10" cy="4.5" r="1.7" />
      <circle cx="4"  cy="4.5" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="10" cy="4.5" r="0.5" fill="currentColor" stroke="none" />
      <path d="M2 9.5 L4 7 L10 7 L12 9.5" />
    </svg>
  )
}

interface DialProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  color: string
  size?: number
  unit?: string
  formatValue?: (value: number) => string
}

const DOT_COUNT = 20
const MIN_ANGLE = -135
const MAX_ANGLE = 135

export function Dial({ value, onChange, label, color, size = 88, min, max, step = 1 }: DialProps) {
  const elRef = useRef<HTMLDivElement>(null)

  // stateRef keeps always-current values accessible inside the once-registered event handlers,
  // avoiding stale closure issues without re-running the effect.
  const stateRef = useRef({ value, onChange, min, max, step })
  stateRef.current = { value, onChange, min, max, step }

  const dragRef = useRef<{
    startX: number
    startY: number
    startValue: number
    totalMovement: number
    currentValue: number
  } | null>(null)

  useEffect(() => {
    const el = elRef.current
    if (!el) return

    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

    const onPointerMove = (ev: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const { min, max, step, onChange } = stateRef.current
      const dx = ev.clientX - drag.startX
      const dy = drag.startY - ev.clientY              // up = positive
      drag.totalMovement += Math.abs(ev.movementX || 0) + Math.abs(ev.movementY || 0)
      // Dominant axis; 200 px of movement = full scale (min → max)
      const primary = Math.abs(dx) >= Math.abs(dy) ? dx : dy
      drag.currentValue = drag.startValue + (primary / 200) * (max - min)
      const snapped = Math.round(drag.currentValue / step) * step
      onChange(clamp(snapped, min, max))
    }

    const onPointerUpOrCancel = (ev: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return

      // Tap: small total movement → jump value to the tapped angle on the knob
      if (drag.totalMovement < 20) {
        const { min, max, step, onChange } = stateRef.current
        const rect = el.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        const angleDeg = Math.atan2(ev.clientX - cx, -(ev.clientY - cy)) * (180 / Math.PI)
        const clamped = clamp(angleDeg, -135, 135)
        const ratio = (clamped + 135) / 270
        const raw = min + ratio * (max - min)
        const snapped = Math.round(raw / step) * step
        onChange(clamp(snapped, min, max))
      }

      dragRef.current = null
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUpOrCancel)
      el.removeEventListener('pointercancel', onPointerUpOrCancel)
    }

    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault()                          // prevent mobile scroll/zoom capture
      el.setPointerCapture(e.pointerId)           // keep events even if pointer leaves element
      const { value } = stateRef.current
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startValue: value,
        totalMovement: 0,
        currentValue: value,
      }
      el.addEventListener('pointermove', onPointerMove)
      el.addEventListener('pointerup', onPointerUpOrCancel)
      el.addEventListener('pointercancel', onPointerUpOrCancel)
    }

    // passive: false is required so we can call preventDefault() and block mobile scroll
    el.addEventListener('pointerdown', onPointerDown, { passive: false })
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])

  const ratio       = (value - min) / (max - min)
  const activeAngle = MIN_ANGLE + ratio * (MAX_ANGLE - MIN_ANGLE)
  const center      = size / 2
  const ringR       = size / 2 - 4
  const outerInset  = Math.round(size * 0.11)
  const innerInset  = Math.round(size * 0.155)
  const pointerArm  = (size / 2 - innerInset) * 0.72
  const dotR        = size * 0.032
  const dotRActive  = size * 0.043

  return (
    <div className="flex flex-col items-center gap-2 select-none">
      <div
        ref={elRef}
        className="relative cursor-ns-resize"
        style={{ width: size, height: size, touchAction: 'none', userSelect: 'none', outline: 'none' }}
        tabIndex={0}
        role="slider"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={label}
        onKeyDown={(e) => {
          const { value, onChange, min, max, step } = stateRef.current
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault()
            onChange(Math.min(max, value + step))
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault()
            onChange(Math.max(min, value - step))
          }
        }}
      >
        {/* Dots ring — SVG rotated so 0° is at the left-bottom */}
        <svg
          viewBox={`0 0 ${size} ${size}`}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ transform: 'rotate(-90deg)' }}
        >
          {Array.from({ length: DOT_COUNT }, (_, i) => {
            const fraction = i / (DOT_COUNT - 1)
            const angleDeg = MIN_ANGLE + fraction * (MAX_ANGLE - MIN_ANGLE)
            const angleRad = (angleDeg * Math.PI) / 180
            const cx = center + ringR * Math.cos(angleRad)
            const cy = center + ringR * Math.sin(angleRad)
            const active = fraction <= ratio
            return (
              <circle
                key={i}
                cx={cx} cy={cy}
                r={active ? dotRActive : dotR}
                fill={active ? color : '#3a3d4a'}
                style={{ filter: active ? `drop-shadow(0 0 2.5px ${color})` : 'none' }}
              />
            )
          })}
        </svg>

        {/* Knob outer rim — neumorphic */}
        <div
          className="absolute rounded-full"
          style={{
            inset: outerInset,
            background: '#1c1f2e',
            boxShadow: '5px 5px 12px #0d0f18, -3px -3px 9px #2b2f45',
          }}
        />

        {/* Knob inner face */}
        <div
          className="absolute rounded-full"
          style={{
            inset: innerInset,
            background: 'radial-gradient(circle at 35% 35%, #2a2d3e, #16192a)',
            boxShadow: 'inset 2px 2px 7px #0d0f18, inset -2px -2px 5px #2b2f45',
          }}
        >
          {/* Indicator dot */}
          <div
            className="absolute rounded-full"
            style={{
              width:  Math.max(4, size * 0.08),
              height: Math.max(4, size * 0.08),
              background: color,
              boxShadow: `0 0 5px ${color}`,
              top: '50%',
              left: '50%',
              transformOrigin: '50% 50%',
              transform: `translate(-50%, -50%) rotate(${activeAngle}deg) translateY(-${pointerArm}px)`,
            }}
          />
        </div>
      </div>
      <span
        className="font-medium tracking-wider uppercase text-zinc-400"
        style={{ fontSize: Math.max(9, Math.round(size * 0.13)) }}
      >
        {label}
      </span>
    </div>
  )
}

// ── LED segment display — scrolling track name panel ─────────────────────────
// Mimics the amber VFD / green LED readout on vintage tape decks.

interface LedDisplayProps {
  text: string          // track name (or playlist name when no track)
  trackNum: number | null  // 0-based; pass null when no track loaded
  onClick?: () => void
  expanded?: boolean
}

export function LedDisplay({ text, trackNum, onClick, expanded = false }: LedDisplayProps) {
  const numStr = trackNum !== null ? String(trackNum + 1).padStart(2, '0') : '--'
  // Only animate if text is long enough to overflow the display
  const shouldScroll = text.length > 13

  return (
    <button
      onClick={onClick}
      title={expanded ? 'Skjul liste' : 'Vis liste'}
      className="flex-1 min-w-0 outline-none focus:outline-none"
      style={{ flexShrink: 1 }}
    >
      <div
        style={{
          background: '#050709',
          border: '1px solid #1a2035',
          borderRadius: 4,
          boxShadow: 'inset 0 1px 5px #000c, 0 0 5px #22d3ee14',
          padding: '3px 6px',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          overflow: 'hidden',
          height: 24,
        }}
      >
        {/* Track number — cyan, like a digital counter */}
        <span
          style={{
            fontFamily: '"Courier New", Courier, monospace',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.08em',
            color: '#22d3ee',
            textShadow: '0 0 5px #22d3ee90',
            whiteSpace: 'nowrap',
            flexShrink: 0,
            lineHeight: 1,
          }}
        >
          {numStr}
        </span>
        {/* Dim separator */}
        <span style={{ color: '#252c45', fontSize: 10, flexShrink: 0, lineHeight: 1 }}>·</span>
        {/* Scrolling amber name */}
        <div style={{ flex: 1, overflow: 'hidden', minWidth: 0, position: 'relative' }}>
          <span
            style={{
              fontFamily: '"Courier New", Courier, monospace',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.07em',
              color: '#fbbf24',
              textShadow: '0 0 6px #fbbf2458',
              whiteSpace: 'nowrap',
              display: 'inline-block',
              lineHeight: 1,
              animation: shouldScroll ? 'led-ticker 8s ease-in-out infinite alternate' : 'none',
            }}
          >
            {text}
          </span>
        </div>
        {/* Expand/collapse chevron */}
        <span
          style={{
            color: '#2e3a5a',
            fontSize: 9,
            flexShrink: 0,
            lineHeight: 1,
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.15s',
            display: 'inline-block',
          }}
        >
          ▾
        </span>
      </div>
    </button>
  )
}

// ── Retro transport button ────────────────────────────────────────────────────
// Looks like a high-end vintage tape deck button: chunky neumorphic pill that
// depresses on press. Pass `active` to keep it pressed (e.g. play while playing).

interface RetroButtonProps {
  onClick: () => void
  icon: React.ReactNode
  label: string
  disabled?: boolean
  active?: boolean   // stays pressed / lit (e.g. play button while playing)
  color?: string     // accent glow colour, defaults to #4ade80
  size?: number      // button diameter, default 36
}

export function RetroButton({
  onClick,
  icon,
  label,
  disabled = false,
  active = false,
  color = '#4ade80',
  size = 36,
}: RetroButtonProps) {
  const r = size / 2
  const [pressed, setPressed] = useState(false)
  const isDown = (active || pressed) && !disabled
  const rimShadow = isDown
    ? `inset 3px 3px 8px #0d0f18, inset -2px -2px 6px #2b2f45, 0 0 8px ${color}55`
    : disabled
      ? 'none'
      : '3px 3px 8px #0d0f18, -2px -2px 6px #2b2f45'

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      className="group relative select-none touch-none outline-none"
      style={{ width: size, height: size, borderRadius: r, flexShrink: 0 }}
    >
      {/* Outer rim */}
      <span
        className="absolute inset-0 rounded-full transition-all duration-75"
        style={{
          background: isDown ? '#1a1d2e' : '#1c1f2e',
          boxShadow: rimShadow,
        }}
      />
      {/* Inner face */}
      <span
        className="absolute rounded-full transition-all duration-75"
        style={{
          inset: Math.round(size * 0.1),
          background: isDown
            ? `radial-gradient(circle at 40% 40%, #1e2133, #12151f)`
            : `radial-gradient(circle at 35% 32%, #272b3e, #1a1d2e)`,
          boxShadow: isDown
            ? `inset 2px 2px 6px #0d0f18, inset -1px -1px 4px #2b2f45`
            : `inset -1px -1px 4px #0d0f18, inset 1px 1px 3px #2b2f45`,
        }}
      />
      {/* Icon */}
      <span
        className="absolute inset-0 flex items-center justify-center transition-all duration-75 pointer-events-none"
        style={{
          color: disabled ? '#3a3d4a' : isDown ? color : '#8b90a8',
          filter: isDown && !disabled ? `drop-shadow(0 0 3px ${color})` : 'none',
          transform: isDown ? 'translateY(1px)' : 'none',
        }}
      >
        {icon}
      </span>
    </button>
  )
}
