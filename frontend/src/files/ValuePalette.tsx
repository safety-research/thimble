// A value's colors: thimble's twelve label colors (no purple, the agents' color), the value's own ringed, then Reset
// colors when the choice's values have colors picked for them. A chip's swatch in Color by opens it (ColorBy), and so
// does a class's swatch in the label editor (LabelCard), which offers the grey of a value with no color too. It takes
// the focus on the value's own color, so that Escape closes it alone and Tab starts there.
import { useEffect, useRef, type CSSProperties } from 'react'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { colourVar, LABEL_COLOURS } from './labels'

interface Props {
  /** the value's name and its color as a CSS color */
  value: { name: string; color: string | null }
  /** a palette color, 1 to LABEL_COLOURS, or 0 for the grey */
  onPick: (color: number) => void
  onReset?: () => void
  /** the grey after the twelve colors */
  grey?: boolean
}

export function ValuePalette({ value, onPick, onReset, grey }: Props) {
  const colors = Array.from({ length: LABEL_COLOURS }, (_, i) => i + 1).concat(grey ? [0] : [])
  const grid = useRef<HTMLDivElement>(null)
  // a frame later: the popover keeps the sheet hidden until it is placed, and a hidden button takes no focus
  useEffect(() => {
    const raf = requestAnimationFrame(() => (grid.current?.querySelector<HTMLButtonElement>('.colorby-pick.on') ?? grid.current?.querySelector<HTMLButtonElement>('.colorby-pick'))?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <>
      <div className="colorby-palette-head">
        <span className="colorby-sw" style={{ '--c': value.color ?? undefined } as CSSProperties} />
        {value.name}
      </div>
      <div ref={grid} className="colorby-palette-grid">
        {colors.map((n) => {
          const now = value.color === colourVar(n)
          return <button key={n} type="button" className={'colorby-pick' + (now ? ' on' : '')} style={{ '--c': colourVar(n) } as CSSProperties} aria-label={n ? `Color ${n}` : 'Grey'} aria-pressed={now} onClick={() => onPick(n)} />
        })}
      </div>
      {onReset && (
        <Button variant="ghost" size="sm" className="colorby-repick" onClick={onReset}>
          <Icon name="reset" size={12} />
          Reset colors
        </Button>
      )}
    </>
  )
}
