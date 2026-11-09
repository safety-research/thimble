// What the tour's example panes (./main.tsx, in the frame example.html) let the tour do from the page around them
// (src/tour/steps.ts). The frame is of the page's own origin, so the tour calls these on the frame's window.

/** A box in the frame's px. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** What the panes tell the tour. */
export interface PanesListeners {
  /** the person pressed, typed or scrolled in the panes (a demo playing stops) */
  input?: () => void
  /** the person pressed Escape and nothing in the panes took it (the tour closes) */
  escape?: () => void
  /** the person closed the Labels sidebar (its ×, or Escape in it), or asked for it (a label's name in Files) */
  side?: (open: boolean) => void
}

export interface ExamplePanes {
  /** where the Files pane stands, and the Labels sidebar while it is open (null: closed) */
  place: (files: Box, side: Box | null) => void
  /** the Files pane shows its open file: the example is in place */
  ready: () => boolean
  /** as the Labels step's demo starts: the panes as the Files step first shows them, the agent's transcript in front
   * and plain (the label off, its Color by Off) */
  reset: () => void
  /** colored by the label, as its Color Files by it does: the label on, first in Color by */
  color: () => void
  /** the label off again, as the Files step shows the transcript */
  plain: () => void
  /** the parts the demo's pointer goes to: Color by's control, and the label's row in its menu once open */
  part: (name: 'color-by' | 'color-by-label') => HTMLElement | null
  /** what the panes hold open over them closes, as Escape closes it: a menu, the label's editor */
  close: () => Promise<void>
  listen: (fns: PanesListeners) => void
}

/** The name the frame's window gives its panes under. */
export const PANES_KEY = 'thimbleExamplePanes'
