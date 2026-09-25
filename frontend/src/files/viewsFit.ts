// Which of Files' views fit in its pane head (files/ViewsBar compact): the options in order while they fit, the rest in the ⋯
// menu. The picked option always shows, in its own place among those shown, taking the room of the last ones that fit;
// in a bar too narrow for even the picked option beside ⋯ and New view, every option goes in the menu.

export interface FitInput {
  /** each option's width in px, in the bar's order */
  widths: readonly number[]
  /** the room the bar has, in px */
  room: number
  /** the gap between two items, in px */
  gap: number
  /** the width of what always follows the options (New view), in px */
  tail: number
  /** the width of the ⋯ button that holds the options that do not fit, in px */
  more: number
  /** the picked option's index, or -1 */
  active: number
}

/** The indices of the options the bar shows, ascending; the others go in the ⋯ menu. */
export function fitViews({ widths, room, gap, tail, more, active }: FitInput): number[] {
  const all = widths.map((_, i) => i)
  const need = (ws: readonly number[], extra: number[]) => {
    const items = [...ws, ...extra]
    return items.reduce((a, w) => a + w, 0) + gap * Math.max(0, items.length - 1)
  }
  if (need(widths, [tail]) <= room) return all
  const shown: number[] = []
  for (const i of all) {
    if (need([...shown.map((j) => widths[j]), widths[i]], [more, tail]) > room) break
    shown.push(i)
  }
  if (active < 0 || active >= widths.length || shown.includes(active)) return shown
  // the picked option takes the place of the last ones shown until it fits
  if (need([widths[active]], [more, tail]) > room) return []
  while (shown.length && need([...shown.map((j) => widths[j]), widths[active]], [more, tail]) > room) shown.pop()
  return [...shown, active].sort((a, b) => a - b)
}
