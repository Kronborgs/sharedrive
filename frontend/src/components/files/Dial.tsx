import { useCallback, useRef } from 'react'

interface DialProps {
  value: number          // 0–1
  onChange: (v: number) => void
  label: string
  color: string
  size?: number          // outer diameter in px, default 88
}

const DOT_COUNT = 20
const MIN_ANGLE = -135
const MAX_ANGLE = 135

function valueToAngle(v: number) {
  return MIN_ANGLE + v * (MAX_ANGLE - MIN_ANGLE)
}

export function Dial({ value, onChange, label, color, size = 88 }: DialProps) {
  const startY   = useRef<number | null>(null)
  const startVal = useRef(value)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    startY.current   = e.clientY
    startVal.current = value
  }, [value])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (startY.current === null) return
    const dy    = startY.current - e.clientY   // drag up = increase
    const delta = dy / 120                      // 120 px = full sweep
    onChange(Math.max(0, Math.min(1, startVal.current + delta)))
  }, [onChange])

  const onPointerUp = useCallback(() => { startY.current = null }, [])

  const activeAngle  = valueToAngle(value)
  const center       = size / 2
  const ringR        = size / 2 - 4
  const outerInset   = Math.round(size * 0.11)
  const innerInset   = Math.round(size * 0.155)
  const pointerArm   = (size / 2 - innerInset) * 0.72
  const dotR         = size * 0.032
  const dotRActive   = size * 0.043

  return (
    <div className="flex flex-col items-center gap-2 select-none">
      <div
        className="relative cursor-ns-resize touch-none"
        style={{ width: size, height: size }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
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
            const active = angleDeg <= activeAngle
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
