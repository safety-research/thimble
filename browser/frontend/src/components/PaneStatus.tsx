// The pane's status strip: glass along the pane's bottom edge, 28px, mono 11. The surface's name in
// ink, then what it shows, and its totals at the right. Every surface's strip is this part.
import type { ReactNode } from 'react'

export interface PaneStatusProps {
  /** the surface: Files, Canvas, Report */
  name: string
  /** what it shows: the open file and its mode, a view */
  meta?: ReactNode
  /** its totals: files and size, cells and groups */
  totals?: ReactNode
  className?: string
}

export function PaneStatus({ name, meta, totals, className }: PaneStatusProps) {
  return (
    <div className={'pane-status' + (className ? ` ${className}` : '')} role="status">
      <span className="pane-status-name">{name}</span>
      {meta != null && meta !== '' && <span className="pane-status-meta">{meta}</span>}
      {totals != null && totals !== '' && <span className="pane-status-totals">{totals}</span>}
    </div>
  )
}
