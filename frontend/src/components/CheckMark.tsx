// The mark of a check thimble runs on something it made, shared by the card check (canvas/CardFace) and the review of a
// view's pictures (files/ViewPane). The review's: a spinner while it runs, a check glyph when it is done, a flag when it
// left problems, a run-again glyph when it failed or was stopped. The card check's: only `problem`, a red ✕ for a real
// problem it found. Its hover card, on the page rather than inside the thing checked (which may clip it), explains the
// state. A click does what `onClick` does, such as running a finished check again; without one it opens the hover card.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { Mark } from './Marks'
import { Spinner } from './Spinner'
import { placeTip } from './Tooltip'

export type CheckState = 'running' | 'done' | 'checked' | 'failed' | 'stopped'

export interface CheckMarkProps {
  state: CheckState
  /** a finer state for the mark's class, such as a check waiting for capacity */
  phase?: string
  /** the check left problems: the flag glyph */
  flagged?: boolean
  /** the check found a real problem: the red ✕ (Marks `failed`), in place of any other glyph */
  problem?: boolean
  /** the mark's accessible name */
  label: string
  /** the hover card's accessible name */
  popLabel: string
  /** what a click on the mark does, such as stop a running check or run a finished one again; without it a click opens
   * the hover card */
  onClick?: () => void
  /** the hover card's content; `close` hides it, as an action in it does */
  children: (close: () => void) => ReactNode
  className?: string
}

export function CheckMark({ state, phase, flagged, problem, label, popLabel, onClick, children, className }: CheckMarkProps) {
  const [open, setOpen] = useState(false)
  const at = useRef<HTMLButtonElement>(null)
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (hide.current && clearTimeout(hide.current)), [])
  const enter = () => {
    if (hide.current) clearTimeout(hide.current)
    setOpen(true)
  }
  const leave = () => {
    hide.current = setTimeout(() => setOpen(false), 180)
  }
  const stop = (e: MouseEvent) => e.stopPropagation()
  const running = state === 'running'
  const ended = state === 'failed' || state === 'stopped'
  return (
    <span className={'bcell-check' + (className ? ` ${className}` : '')} onMouseEnter={enter} onMouseLeave={leave} onMouseDown={stop} onClick={stop}>
      <button
        ref={at}
        type="button"
        className={`bcell-check-mark is-${state}${phase ? ` is-${phase}` : ''}${flagged ? ' is-flagged' : ''}${problem ? ' is-problem' : ''}`}
        aria-label={label}
        aria-haspopup={onClick ? undefined : 'dialog'}
        onFocus={enter}
        onBlur={leave}
        onClick={() => {
          if (!onClick) return enter()
          setOpen(false)
          onClick()
        }}
      >
        {problem ? <Mark kind="failed" label="problem" /> : running ? <Spinner size={10} /> : <Icon name={ended ? 'refresh' : flagged ? 'flag' : 'check'} size={12} />}
      </button>
      {open && at.current && (
        <CheckPop anchor={at.current} onEnter={enter} onLeave={leave} label={popLabel}>
          {children(() => setOpen(false))}
        </CheckPop>
      )}
    </span>
  )
}

/** The mark's hover card, on the page, under the mark or over it where there is no room below. */
export function CheckPop({ anchor, onEnter, onLeave, label, children }: { anchor: HTMLElement; onEnter: () => void; onLeave: () => void; label: string; children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const pop = el.current
    if (pop) setPos(placeTip(anchor.getBoundingClientRect(), pop.offsetWidth, pop.offsetHeight, window.innerWidth, window.innerHeight))
  }, [anchor])
  return createPortal(
    <div
      ref={el}
      className="bcell-check-pop overlay"
      role="dialog"
      aria-label={label}
      style={{ position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}
