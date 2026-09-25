// Where the canvas lands when the analyst switches to its tab while it has its dot (cards made since it was last shown):
// - an analyst who has seen none of the board's cards lands at the orientation's deck from its top, or the top frame
//   when there is no deck (layout.openingFrame);
// - one who has seen some lands on the newest card made while the tab was hidden;
// - with no card made meanwhile, the board stays where it was left.
// A card counts as seen once it has been in the viewport while the tab is shown (`canvas-seen`, per browser).

export type Landing = { kind: 'stay' } | { kind: 'frame'; id: string } | { kind: 'card'; id: string }

export interface LandingInput {
  /** the cards the analyst has had in view on the Canvas tab (canvas-seen) */
  seen: ReadonlySet<string>
  /** the board's cards now */
  cards: Iterable<string>
  /** the cards made while the tab was hidden, oldest first */
  arrived: readonly string[]
  /** where a fresh board starts: the deck, else the top frame (layout.openingFrame); null on an empty board */
  start: string | null
}

/** Whether the analyst has seen any card still on the board, leaving out the ones that just arrived. Pure. */
export function hasExplored(seen: ReadonlySet<string>, cards: Iterable<string>, arrived: readonly string[] = []): boolean {
  const fresh = new Set(arrived)
  for (const id of cards) if (!fresh.has(id) && seen.has(id)) return true
  return false
}

/** Where the canvas lands on a switch to its tab (the rule above). Pure. */
export function canvasLanding({ seen, cards, arrived, start }: LandingInput): Landing {
  if (!arrived.length) return { kind: 'stay' }
  const ids = [...cards]
  if (!hasExplored(seen, ids, arrived)) return start ? { kind: 'frame', id: start } : { kind: 'stay' }
  const on = new Set(ids)
  // the newest one still on the board; else the newest one made, which the canvas waits for while it re-reads
  const newest = [...arrived].reverse().find((id) => on.has(id)) ?? arrived[arrived.length - 1]
  return { kind: 'card', id: newest }
}

/** The most card ids canvas-seen keeps, the latest seen kept. */
export const SEEN_CAP = 4000

/** `seen` with `ids` added, the oldest dropped past SEEN_CAP; the same list when nothing is new. Pure. */
export function addSeen(seen: readonly string[], ids: Iterable<string>): readonly string[] {
  const have = new Set(seen)
  const add = [...new Set(ids)].filter((id) => !have.has(id))
  if (!add.length) return seen
  const next = [...seen, ...add]
  return next.length > SEEN_CAP ? next.slice(next.length - SEEN_CAP) : next
}
