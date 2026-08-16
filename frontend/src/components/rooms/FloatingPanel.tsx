import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

interface PanelPosition {
  left: number
  top: number
  maxHeight: number
}

interface FloatingPanelProps {
  anchorRef: RefObject<HTMLElement | null>
  children: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  ariaLabel: string
  className?: string
}

const viewportMargin = 8
const panelGap = 8

export function FloatingPanel({ anchorRef, children, open, onOpenChange, ariaLabel, className = '' }: Readonly<FloatingPanelProps>) {
  const panelRef = useRef<HTMLDialogElement>(null)
  const [position, setPosition] = useState<PanelPosition>()

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return
    const anchorRect = anchor.getBoundingClientRect()
    const panelWidth = panel.offsetWidth
    const desiredHeight = panel.scrollHeight
    const spaceAbove = anchorRect.top - panelGap - viewportMargin
    const spaceBelow = window.innerHeight - anchorRect.bottom - panelGap - viewportMargin
    const openAbove = spaceAbove >= Math.min(desiredHeight, 360) || spaceAbove > spaceBelow
    const maxHeight = Math.max(160, openAbove ? spaceAbove : spaceBelow)
    const visibleHeight = Math.min(desiredHeight, maxHeight)
    const top = openAbove ? anchorRect.top - panelGap - visibleHeight : anchorRect.bottom + panelGap
    const left = Math.min(Math.max(viewportMargin, anchorRect.right - panelWidth), window.innerWidth - panelWidth - viewportMargin)
    setPosition({ left, top: Math.max(viewportMargin, top), maxHeight })
  }, [anchorRef])

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
  }, [children, open, updatePosition])

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node
      if (!panelRef.current?.contains(target) && !anchorRef.current?.contains(target)) onOpenChange(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [anchorRef, onOpenChange, open, updatePosition])

  if (!open) return null
  return createPortal(
    <dialog
      ref={panelRef}
      open
      aria-label={ariaLabel}
      className={`fixed m-0 z-[100] overflow-y-auto rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-[#34394f] dark:bg-[#1a1d27] ${className}`}
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, maxHeight: position?.maxHeight, visibility: position ? 'visible' : 'hidden' }}
    >
      {children}
    </dialog>,
    document.body,
  )
}
