// A label over files as a mark: a single-class label's square in its colour, filled while on, or a multi-class label's
// glyph in the plain ink, with its number (labels.ts laneTags) at the upper right while on. Used by the Labels pane, the
// reader's gutter head and the Table's head.
import type { CSSProperties } from 'react'
import { Icon } from '../components/Icon'

interface Props {
  multi: boolean
  /** the square's colour (mainColour); a multi-class label's glyph ignores it */
  colour: string
  on: boolean
  /** px, the glyph's box; the square's size is set in files.css where it stands */
  glyph?: number
  /** a multi-class label's number among the multi-class labels that are on, from 1; none while it is off */
  n?: number
}

export function LabelMark({ multi, colour, on, glyph = 13, n }: Props) {
  const cls = on ? ' on' : ''
  const mark = multi ? <Icon name="label" size={glyph} className={'files-label-tag' + cls} /> : <span className={'files-label-box' + cls} style={{ '--c': colour } as CSSProperties} />
  if (!multi || !n) return mark
  return (
    <span className="label-mark">
      {mark}
      <span className="label-mark-n">{n}</span>
    </span>
  )
}
