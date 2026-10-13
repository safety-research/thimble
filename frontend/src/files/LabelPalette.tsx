// A label's colours in a popover, from the Labels pane: one swatch per palette colour around the colour wheel, then the
// grey (labels.ts pickerColours), the value's
// own ringed. A label with more than one coloured value lists its values first, to pick which one takes the colour. A
// pick is saved at once, without a run (FilesLabels setColour), so Files, the label card and every open view show it. A
// view's page offers the same palette, which it hears through thimble.onLabels.
import { useEffect, useState, type CSSProperties, type RefObject } from 'react'
import { Popover } from '../components/Menu'
import type { Concept } from '../lib/types'
import { classesOf, colourVar, isMultiClass, pickerColours } from './labels'

interface Props {
  label: Concept
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  /** save `value`'s colour, a palette index */
  onPick: (value: string, colour: number) => void
}

export function LabelPalette({ label, anchor, open, onClose, onPick }: Props) {
  const classes = classesOf(label)
  const multi = isMultiClass(classes)
  const lead = (classes.find((c) => c.highlight) ?? classes[0])?.name ?? ''
  const [value, setValue] = useState(lead)
  useEffect(() => {
    if (open) setValue(lead)
  }, [open, lead])
  const current = classes.find((c) => c.name === value)?.color
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} label={`Colors of ${label.name}`} className="label-palette">
      {multi && (
        <div className="label-palette-values" role="radiogroup" aria-label="Value">
          {classes.map((c) => (
            <button
              key={c.name}
              type="button"
              role="radio"
              aria-checked={c.name === value}
              className={'label-palette-value' + (c.name === value ? ' active' : '')}
              style={{ '--c': colourVar(c.color) } as CSSProperties}
              onClick={() => setValue(c.name)}
            >
              <span className="label-palette-dot" />
              {c.name}
            </button>
          ))}
        </div>
      )}
      <div className="label-palette-grid">
        {pickerColours(true).map((n) => (
          <button
            key={n}
            type="button"
            className={'label-palette-colour' + (n === current ? ' is-current' : '')}
            style={{ '--c': colourVar(n) } as CSSProperties}
            aria-label={n ? `Color ${n}` : 'Gray'}
            aria-pressed={n === current}
            onClick={() => {
              onPick(value, n)
              onClose()
            }}
          />
        ))}
      </div>
    </Popover>
  )
}
