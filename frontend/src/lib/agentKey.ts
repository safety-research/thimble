// ⌘ while typing: with the caret in text that can go to the agent (a report block, a slide's or the story's text, a
// card's question), holding ⌘ (Ctrl off a Mac, lib/platform) tints that text in the accent, and ⌘↵ sends it to main as
// a request made at that place (a `card` event, prompts/main.md). Text registers as a zone: the element that holds the
// focus while it is typed in, and what ⌘↵ would send from it now. The ⌘ pointer (pointer/CmdPointer) keeps the mouse:
// once the mouse moves with ⌘ held the tint goes, since the analyst is pointing. A shortcut (⌘ with another key) shows
// no tint: the tint waits TINT_DELAY_MS after ⌘ goes down and goes at the next key.
import { api } from './api'
import { bus } from './bus'
import { isMacPlatform, isPointKey, pointKeyHeld } from './platform'

/** How long (ms) ⌘ stays down alone before the tint shows. */
export const TINT_DELAY_MS = 180
/** How far (px) the mouse moves with ⌘ held before the tint goes. */
const POINTING_PX = 4

export interface AgentTarget {
  /** shows or hides the tint on what ⌘↵ would send */
  tint: (on: boolean) => void
  /** sends it */
  send: () => void
}

interface Zone {
  root: HTMLElement
  /** what ⌘↵ sends from the focused element inside `root`, or null when there is nothing to send */
  target: () => AgentTarget | null
}

const zones = new Set<Zone>()
let shown: AgentTarget | null = null
let timer: number | null = null
let armedAt: { x: number; y: number } | null = null
const mouse = { x: 0, y: 0 }

/** The target of the innermost zone that holds the focus. */
function current(): AgentTarget | null {
  const el = document.activeElement
  if (!el) return null
  let best: Zone | null = null
  for (const z of zones) if (z.root.contains(el) && (!best || best.root.contains(z.root))) best = z
  return best ? best.target() : null
}

function clear(): void {
  if (timer != null) window.clearTimeout(timer)
  timer = null
  armedAt = null
  shown?.tint(false)
  shown = null
}

function onKeyDown(e: KeyboardEvent): void {
  const mac = isMacPlatform()
  if (e.key === 'Enter' && pointKeyHeld(e, mac) && !e.shiftKey && !e.altKey && !e.isComposing) {
    const t = current()
    if (!t) return
    e.preventDefault()
    e.stopImmediatePropagation()
    clear()
    t.send()
    return
  }
  if (isPointKey(e.key, mac)) {
    if (armedAt) return
    armedAt = { ...mouse }
    timer = window.setTimeout(() => {
      timer = null
      if (!armedAt) return
      const t = current()
      if (!t) return
      shown = t
      t.tint(true)
    }, TINT_DELAY_MS)
    return
  }
  clear()
}

function onKeyUp(e: KeyboardEvent): void {
  if (isPointKey(e.key) || !pointKeyHeld(e)) clear()
}

function onMouseMove(e: MouseEvent): void {
  mouse.x = e.clientX
  mouse.y = e.clientY
  if (armedAt && Math.hypot(e.clientX - armedAt.x, e.clientY - armedAt.y) > POINTING_PX) {
    if (timer != null) window.clearTimeout(timer)
    timer = null
    shown?.tint(false)
    shown = null
  }
}

function listen(on: boolean): void {
  const method = on ? 'addEventListener' : 'removeEventListener'
  window[method]('keydown', onKeyDown as EventListener, true)
  window[method]('keyup', onKeyUp as EventListener, true)
  window[method]('blur', clear)
  document[method]('mousemove', onMouseMove as EventListener, true)
  document[method]('focusout', clear, true)
}

/** Registers text that ⌘↵ can send: `target` is read when ⌘ goes down or Enter is pressed with it, while the focus is
 * inside `root`. Returns the unregister. */
export function addAgentZone(root: HTMLElement, target: () => AgentTarget | null): () => void {
  const zone: Zone = { root, target }
  if (!zones.size) listen(true)
  zones.add(zone)
  return () => {
    zones.delete(zone)
    if (shown && !zones.size) clear()
    if (!zones.size) listen(false)
  }
}

/** Toggles the tint on an element the page draws (a field and what wraps it), through `data-agent`, which no render
 * owns (report.css). */
export const tintElement =
  (el: () => HTMLElement | null) =>
  (on: boolean): void => {
    el()?.toggleAttribute('data-agent', on)
  }

/** A new id for a request sent to main (⌘↵, /card): the stream's `card-request` names the card made for it. Letters
 * and digits, as the server's `request:<id>` group takes them. */
export function newRequest(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/** Where a request was made: in document `doc` after the passage `after` names (`report:<doc>#…`), or on card `card`. */
export interface AskPlace {
  doc?: string
  after?: string
  card?: string
}

/** Sends `text` to main as a request made at `place` (`POST …/events {kind: card}`), under a new id; resolves to that
 * id once the event landed. A card main makes for it comes back on the bus as `cardRequest` with the id. */
export async function askMain(ws: string, text: string, place: AskPlace = {}): Promise<string> {
  const request = newRequest()
  await api.askCard(ws, { text, request, ...place })
  return request
}

/** Calls `fn` once main's turn has ended (main not running, as the chats list says after each change to main's
 * chat). Returns the cancel. */
export function whenMainIdle(ws: string, fn: () => void): () => void {
  let done = false
  let timer: number | null = null
  const check = async () => {
    try {
      const metas = await api.chats(ws)
      const main = metas.find((m) => m.id === 'main')
      if (!done && main && !main.running) {
        done = true
        off()
        fn()
      }
    } catch {
      /* the next change to main's chat reads it again */
    }
  }
  const off = bus.on('chat', (e) => {
    if (e.chat !== 'main' || done) return
    if (timer != null) window.clearTimeout(timer)
    timer = window.setTimeout(() => void check(), 300)
  })
  return () => {
    done = true
    off()
    if (timer != null) window.clearTimeout(timer)
  }
}
