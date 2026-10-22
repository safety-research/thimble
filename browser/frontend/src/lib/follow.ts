// Following Claude's cards: when Claude makes a card during a turn, the page shows the canvas (shell/Shell.tsx) and the
// canvas goes to the card (canvas/Canvas.tsx), unless the person is busy. Busy means a press, a key or the wheel in the
// last FOLLOW_QUIET_MS, or the focus in a field outside the chat (the report's editor, a label's form). The chat's own
// composer does not count: it keeps the focus after a message is sent, and the panes beside it can change without
// touching what is typed there. A card the person made, and the history the stream replays on load, are never followed.
import { isReplay } from './events'

/** How long after the person's last press, key or wheel the page leaves the panes alone. */
export const FOLLOW_QUIET_MS = 5000

const PERSON = new Set(['user', 'analyst'])

/** The card a stream event says Claude made: a `cell` record of a card created, by a maker other than the person.
 * A record without a maker (a server from before `by`) is not followed. Pure. */
export function cardClaudeMade(ev: Record<string, unknown>): string | null {
  if (ev.type !== 'cell' || ev.op !== 'created' || typeof ev.cell !== 'string') return null
  const by = typeof ev.by === 'string' ? ev.by : ''
  return by && !PERSON.has(by) ? ev.cell : null
}

let lastInput = -Infinity
let watching = false

/** Starts noting the person's presses, keys and wheel turns (once per page). */
export function watchInput(): void {
  if (watching || typeof document === 'undefined') return
  watching = true
  const note = () => {
    lastInput = performance.now()
  }
  for (const type of ['pointerdown', 'keydown', 'wheel'] as const) document.addEventListener(type, note, { capture: true, passive: true })
}

/** Whether `el` takes typing: a text field, a text area or an editable element. Pure. */
export function isField(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(el.type)
  return el instanceof HTMLElement && el.isContentEditable
}

/** Whether the person is busy (the rule above), for `now` and `focus` as given. Pure. */
export function busy(now: number, last: number, focus: Element | null): boolean {
  if (now - last < FOLLOW_QUIET_MS) return true
  return isField(focus) && !focus!.closest('.chat[data-panel="chat"]')
}

/** Whether the page may follow a card Claude just made: a live record (not the replay) and the person not busy. */
export function mayFollow(): boolean {
  return !isReplay() && !busy(performance.now(), lastInput, document.activeElement)
}

/** Whether a stream event should show the canvas: a card Claude made, no pane showing the canvas (the canvas goes to
 * the card itself then), and the page free to follow. */
export function showsCanvas(ev: Record<string, unknown>, shown: readonly string[]): boolean {
  return !!cardClaudeMade(ev) && !shown.includes('canvas') && mayFollow()
}

/** For tests: forget the last input, or set it to `at`. */
export function setLastInput(at = -Infinity): void {
  lastInput = at
}
