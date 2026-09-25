// Whether a wheel's sideways turn belongs to a box under the pointer rather than to the board: a card's table or
// drawing wider than the card scrolls sideways inside it (lib/tables), and the board pans with every other wheel turn.

const scrollsX = (el: HTMLElement): boolean => {
  const o = getComputedStyle(el).overflowX
  return (o === 'auto' || o === 'scroll') && el.scrollWidth > el.clientWidth + 1
}

/** Whether a mostly sideways wheel turn (`dx` past `dy`) over `target` can scroll a box between it and `stop` further
 * that way; a box already at its end in that direction passes the turn on. */
export function takesSideways(target: EventTarget | null, dx: number, dy: number, stop: HTMLElement): boolean {
  if (Math.abs(dx) <= Math.abs(dy) || !(target instanceof Element)) return false
  for (let el: Element | null = target; el && el !== stop; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || !scrollsX(el)) continue
    if (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0) return true
  }
  return false
}
