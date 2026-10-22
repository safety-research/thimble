// The lenses' marks on a report, pure: which marks the page draws and in what color, from the document's `marks` and
// the lenses' colors (GET /lenses). Every mark highlights its words; a check's and an important detail's also stand as a
// card in the margin, while an explainer's card shows only once it is clicked.
import type { ReportMark } from '../lib/types'

/** The lens whose marks are a highlight alone until clicked. */
export const EXPLAIN = 'explain'

export interface LensLook {
  name: string
  /** a viz color family: teal, orange, pink, blue, green, gold, violet */
  color: string
}

/** The highlight's fill and the swatch's and name's ink of a lens's color family. */
export const fillOf = (color: string): string => `var(--viz-${color}-1)`
export const inkOf = (color: string): string => `var(--viz-${color}-3)`

/** A lens's look, a quiet gray for a lens not known. */
export function lookOf(lenses: ReadonlyMap<string, LensLook>, lens: string): LensLook {
  return lenses.get(lens) ?? { name: lens, color: 'gray' }
}

/** The marks whose card stands in the margin: every one but an explainer's, which stands only while it is open. */
export function marginMarks(marks: readonly ReportMark[], active: string | null): ReportMark[] {
  return marks.filter((m) => m.lens !== EXPLAIN || m.id === active)
}
