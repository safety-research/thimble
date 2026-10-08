// The one dim line a prompt label's run leaves under its counts when it read some whole files or runs only in part,
// since they were longer than its model's context holds (the run's `cut`, backend concepts.read_cut): "312 of 776 files
// were longer than the model reads; it read the first ~900k tokens of each". A click opens the list of them under it.
// The Labels pane's row and the label's card on the canvas show it, until a run of the label cuts none.
import { useState } from 'react'
import type { ReadCut } from '../lib/types'

export function ReadCutLine({ cut, className }: { cut: ReadCut; className?: string }) {
  const [open, setOpen] = useState(false)
  const more = cut.n - cut.refs.length
  return (
    <div className={'read-cut' + (className ? ` ${className}` : '')}>
      <button type="button" className="read-cut-line" aria-expanded={open} onMouseDown={(e) => e.stopPropagation()} onClick={() => setOpen((o) => !o)}>
        {cut.line}
      </button>
      {open && (
        <ul className="read-cut-refs">
          {cut.refs.map((ref) => (
            <li key={ref} title={ref}>
              {ref}
            </li>
          ))}
          {more > 0 && <li className="read-cut-more">and {more.toLocaleString()} more</li>}
        </ul>
      )}
    </div>
  )
}
