// One set of gestures for every target the mod draws (a card, a mark, a sentence, a citation, a row, a record, a node):
//
//   click            the target's one action: open the place it cites (a card value has none: its Client selects it)
//   double-click     put the target's citation into the prompt
//   shift+click      a side thread about the target; ctrl+click and middle-click do the same where they arrive as such
//   right-click      a menu of every action
//
// A Client calls onPointer from its pointer listener with the target under the pointer; the gesture is posted to the
// hooks module (register.tsx), which acts on it. The default export is the Client for a block of Markdown, so plain
// paragraphs of a reply are targets too.
import type { ClientModule, ClientPointerEvent, JsonValue } from 'claude-code'

import type { ChatTarget } from '../types'
import { citations } from './lib'
import type { Citation } from './lib'

export type Target = ChatTarget

export type PointerEv = { button: 'left' | 'middle' | 'right'; shift: boolean; ctrl: boolean; alt: boolean; type: 'press' | 'release' | 'double' }

export type Gesture = 'primary' | 'cite' | 'thread' | 'menu'

/** One pointer event as posted: what it was, which gesture it made (null: none), and on what. */
export type Sent = { seq: number; gesture: Gesture | null; target: Target; ev: PointerEv }

/** Two presses on one target within this many milliseconds are a double-click; a click acts once it has passed. */
export const DOUBLE_MS = 350

type Port = { post: (data: JsonValue) => void; every?: (ms: number, fn: () => void) => () => void }

const origin = Math.random().toString(36).slice(2, 10)
let seq = 0
let outbox: Sent[] = []
const waiting = new Map<string, () => void>() // a clicked target -> what cancels its pending click
let lastRightPress = ''

function portOf(ctx: unknown): Port | null {
  const c = ctx as { post?: unknown; surface?: unknown } | null
  if (c && typeof c.post === 'function') return c as Port
  if (c && c.surface) return portOf(c.surface)
  return null
}

/** A Client's raw event (down/up) or an event already in this module's terms; null for moves and edges. */
export function normalize(ev: PointerEv | ClientPointerEvent): PointerEv | null {
  const t = ev.type === 'down' ? 'press' : ev.type === 'up' ? 'release' : ev.type
  if (t !== 'press' && t !== 'release' && t !== 'double') return null
  return { type: t, button: ev.button ?? 'left', shift: Boolean(ev.shift), ctrl: Boolean(ev.ctrl), alt: Boolean(ev.alt) }
}

/** The gesture a press makes; `again` when the same target was pressed within DOUBLE_MS. */
export function classify(ev: PointerEv, again = false): Gesture | null {
  if (ev.type === 'double') return 'cite'
  if (ev.type !== 'press') return null
  if (ev.button === 'middle') return 'thread'
  const mod = ev.shift || ev.ctrl || ev.alt
  // macOS Terminal and iTerm2 can turn ctrl+click into a right-click: one that still carries a modifier is a thread
  if (ev.button === 'right') return mod ? 'thread' : 'menu'
  if (mod) return 'thread'
  return again ? 'cite' : 'primary'
}

export function targetKey(t: Target): string {
  return [t.kind, t.ref ?? '', t.cardId ?? '', (t.text ?? '').slice(0, 80)].join('|')
}

/** Every post carries what this module sent since the last frame, so a post that replaces another in the same frame
 *  (the engine delivers one per frame) loses no gesture; register.tsx drops the ones it has seen. */
function emit(port: Port, entry: Omit<Sent, 'seq'>): void {
  const mine = ++seq
  outbox = [...outbox, { ...entry, seq: mine }].slice(-8)
  port.post({ type: 'gesture', origin, gestures: outbox } as unknown as JsonValue)
  if (port.every) {
    const stop = port.every(120, () => {
      stop()
      outbox = outbox.filter(x => x.seq > mine)
    })
  }
}

/** A Client's other posts (a hover, a param) go through here, so they carry the gestures not yet delivered. */
export function send(ctx: unknown, data: Record<string, JsonValue>): void {
  const port = portOf(ctx)
  if (port) port.post({ ...data, origin, gestures: outbox } as unknown as JsonValue)
}

/** Called by a Client's pointer listener with the target under the pointer, on a press and on a release. `ctx` is the
 *  Client's surface (its `post`, and its `every` for the double-click window). */
export function onPointer(target: Target, ev: PointerEv | ClientPointerEvent, ctx: unknown): void {
  const port = portOf(ctx)
  const e = normalize(ev)
  if (!port || !e) return
  const key = targetKey(target)
  if (e.type === 'release') {
    // a right button that comes up without having gone down here (its press went elsewhere) still opens the menu
    const lost = e.button === 'right' && lastRightPress !== key
    lastRightPress = ''
    emit(port, { gesture: lost ? 'menu' : null, target, ev: e })
    return
  }
  if (e.type === 'press' && e.button === 'right') lastRightPress = key
  const cancel = waiting.get(key)
  const g = classify(e, Boolean(cancel) && e.button === 'left' && !e.shift && !e.ctrl && !e.alt)
  if (cancel) {
    cancel()
    waiting.delete(key)
  }
  if (g === 'primary' && port.every) {
    // a click acts once no second click followed, so a double-click does not also open the place
    emit(port, { gesture: null, target, ev: e })
    const stop = port.every(DOUBLE_MS, () => {
      stop()
      waiting.delete(key)
      emit(port, { gesture: 'primary', target, ev: e })
    })
    waiting.set(key, stop)
    return
  }
  emit(port, { gesture: g, target, ev: e })
}

// ------------------------------------------------------------------------------------------------ what a target means

const CARD_REF = /^card:([A-Za-z0-9_-]+)/

/** The target's citation: a full `[[value|ref]]` in `ref`, or `[[text|ref]]` built from a bare ref and its value. */
export function citationOf(t: Target): Citation | null {
  if (t.kind === 'card') return t.cardId ? { raw: `[[card:${t.cardId}]]`, ref: `card:${t.cardId}`, display: null } : null
  const ref = (t.ref ?? '').trim()
  if (!ref) return null
  if (ref.startsWith('[[')) return citations(ref)[0] ?? null
  const value = t.kind === 'sentence' ? '' : (t.text ?? '').trim()
  return value && !/[|\[\]\n]/.test(value) ? { raw: `[[${value}|${ref}]]`, ref, display: value } : { raw: `[[${ref}]]`, ref, display: null }
}

export function cardOf(t: Target): string {
  return t.cardId || CARD_REF.exec(citationOf(t)?.ref ?? '')?.[1] || ''
}

/** What a double-click or "cite" puts into the prompt: the citation, or a sentence quoted. */
export function citeText(t: Target): string {
  const c = citationOf(t)
  if (c) return c.raw
  const s = (t.text ?? '').replace(/\s+/g, ' ').trim()
  return s ? `"${s.length > 300 ? `${s.slice(0, 299)}…` : s}"` : ''
}

/** The place a click opens: a citation's, or a mark's, row's, record's or node's when it lies outside the cards. */
export function placeOf(t: Target): Citation | null {
  const c = citationOf(t)
  if (!c || t.kind === 'card' || t.kind === 'sentence') return null
  return t.kind === 'citation' || !CARD_REF.test(c.ref) ? c : null
}

export type Act = 'open' | 'thread' | 'verify' | 'script' | 'rerun' | 'cite'
export type MenuItem = { act: Act; label: string; hotkey: string }

/** The menu a right-click opens: every action the target has. */
export function menuItems(t: Target): MenuItem[] {
  const c = citationOf(t)
  const card = cardOf(t)
  const out: MenuItem[] = []
  if (placeOf(t)) out.push({ act: 'open', label: 'open', hotkey: 'o' })
  out.push({ act: 'thread', label: 'ask about this', hotkey: 'a' })
  if (c?.display && t.kind !== 'card' && t.kind !== 'sentence') out.push({ act: 'verify', label: 'verify', hotkey: 'v' })
  if (card && (t.script || t.kind !== 'citation')) out.push({ act: 'script', label: 'open the script', hotkey: 's' }, { act: 'rerun', label: 'rerun', hotkey: 'r' })
  if (citeText(t)) out.push({ act: 'cite', label: 'cite', hotkey: 'c' })
  return out
}

/** A short name for the target, as the menu and the mouse log show it. */
export function targetLabel(t: Target): string {
  const s = (t.text ?? '').replace(/[`*_]+|^\s*(#+|[-*+]|\d+[.)])\s+/g, '').replace(/\s+/g, ' ').trim()
  const short = s.length > 48 ? `${s.slice(0, 47)}…` : s
  switch (t.kind) {
    case 'card':
      return short ? `card "${short}"` : 'card'
    case 'sentence':
      return short ? `"${short}"` : 'sentence'
    case 'citation':
      return citationOf(t)?.display ?? citationOf(t)?.ref ?? 'citation'
    default:
      return short || citationOf(t)?.ref || t.kind
  }
}

// ------------------------------------------------------------------------------------------------ Markdown block

type RegionProps = { text: string }

/** A block of a reply drawn as Markdown, with the gestures of a sentence target. */
const Region: ClientModule<RegionProps> = (props, surface) => {
  const { Markdown } = surface.elements
  surface.onPointer(ev => onPointer({ kind: 'sentence', text: props.text.slice(0, 1200) }, ev, surface))
  return Markdown({ text: props.text })
}

export default Region
