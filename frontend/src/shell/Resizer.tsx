// The drag handle on the inner edge of a side pane.
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

interface ResizerProps {
  side: 'left' | 'right'
  width: number
  min: number
  max: number
  defaultWidth: number
  onResize: (width: number) => void
  onEnd: (width: number) => void
}

export function Resizer({ side, width, min, max, defaultWidth, onResize, onEnd }: ResizerProps) {
  const drag = useRef<{ startX: number; startW: number; last: number } | null>(null)
  const [active, setActive] = useState(false)
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startW: width, last: width }
    setActive(true)
    document.body.classList.add('shell-resizing')
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.startX
    d.last = clamp(d.startW + (side === 'left' ? dx : -dx), min, max)
    onResize(d.last)
  }
  const finish = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    setActive(false)
    document.body.classList.remove('shell-resizing')
    onEnd(d.last)
  }
  return (
    <div
      className={active ? 'shell-resizer active' : 'shell-resizer'}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={() => {
        onResize(defaultWidth)
        onEnd(defaultWidth)
      }}
    />
  )
}
