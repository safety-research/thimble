// One set of gestures for every target a Client of the mod draws (a card, a mark, a row, a record, a node):
//
//   click            the target's one action: open the place it cites, or a side thread about a card
//   double-click     the same as a click
//   right-click      the same as a click: there is no menu
//
// Modifier clicks and the middle button are left alone: terminals keep them for their own selection, and a gesture
// that works in one terminal and not the next is worse than none. A reply's paragraphs are the engine's Markdown, each
// citation a link a plain click presses (register.tsx), so their text selects as usual.
//
// A Client calls onPointer from its pointer listener with the target under the pointer; the gesture is posted to the
// hooks module (register.tsx), which acts on it.
import type { ClientModule, ClientPointerEvent, JsonValue } from 'claude-code'

import type { ChatTarget } from '../types'
import { citeLabel, plainCites } from './cite'
import { citations, cut, quoted } from './lib'
import type { Citation } from './lib'

export type Target = ChatTarget

export type PointerEv = { button: 'left' | 'middle' | 'right'; shift: boolean; ctrl: boolean; alt: boolean; type: 'press' | 'release' | 'double' }

/** A click's (a right-click does what a click does). */
export type Gesture = 'primary'

/** One pointer event as posted: what it was, which gesture it made (null: none), and on what. */
export type Sent = { seq: number; gesture: Gesture | null; target: Target; ev: PointerEv }

type Port = { post: (data: JsonValue) => void; every?: (ms: number, fn: () => void) => () => void }

const origin = Math.random().toString(36).slice(2, 10)
let seq = 0
let outbox: Sent[] = []
let rightDown = false // a right press reached this module and its release has not

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

/** The gesture a press makes: a left or right press (once or twice) its one action; the rest none (a modified click
 *  and the middle button are the terminal's). */
export function classify(ev: PointerEv): Gesture | null {
  if (ev.type === 'double') return 'primary'
  if (ev.type !== 'press') return null
  return (ev.button === 'left' || ev.button === 'right') && !ev.shift && !ev.ctrl && !ev.alt ? 'primary' : null
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
  if (e.type === 'release') {
    // The press picks the target. The panel it opens can reflow the transcript before the release, which then lands
    // on another target; only a right release whose press never reached this module acts, as a click.
    const lost = e.button === 'right' && !rightDown && !e.shift && !e.ctrl && !e.alt
    if (e.button === 'right') rightDown = false
    emit(port, { gesture: lost ? 'primary' : null, target, ev: e })
    return
  }
  if (e.type === 'press' && e.button === 'right') rightDown = true
  emit(port, { gesture: classify(e), target, ev: e })
}

// ------------------------------------------------------------------------------------------------ what a target means

const CARD_REF = /^card:([A-Za-z0-9_-]+)/

/** The target's citation: a full `[[value|ref]]` in `ref`, `[[text|ref]]` for a mark or a row (its text is the value
 *  shown), or `[[ref]]` (a record's or a node's text is words about it, not a value). */
export function citationOf(t: Target): Citation | null {
  if (t.kind === 'card') return t.cardId ? { raw: `[[card:${t.cardId}]]`, ref: `card:${t.cardId}`, display: null } : null
  const ref = (t.ref ?? '').trim()
  if (!ref) return null
  if (ref.startsWith('[[')) return citations(ref)[0] ?? null
  const value = t.kind === 'mark' || t.kind === 'row' ? (t.text ?? '').trim() : ''
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
  return s ? quoted(cut(s, 300)) : ''
}

/** The place a click opens: a citation's; a mark's, row's, record's or node's when it lies outside the cards. Plain
 *  words (a sentence, a reply's table row) open nothing: only what is drawn as a link opens a panel. */
export function placeOf(t: Target): Citation | null {
  if (t.kind === 'card' || t.kind === 'sentence' || (t.kind === 'row' && !t.ref)) return null
  const c = citationOf(t)
  if (!c) return null
  return t.kind === 'citation' || !CARD_REF.test(c.ref) ? c : null
}

export type Act = 'open' | 'thread' | 'verify' | 'script' | 'rerun' | 'files'
/** A short name for the target in at most `max` characters, as the mouse log and a thread's title show it: each citation by
 *  its label, never its ref; quoted words keep their closing quote when cut. */
export function targetLabel(t: Target, max = 48): string {
  const s = plainCites(t.text ?? '')
    .replace(/[`*_]+|^\s*(#+|[-*+]|\d+[.)])\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const n = Math.max(8, max)
  const c = citationOf(t)
  switch (t.kind) {
    case 'card':
      return s ? `card ${quoted(cut(s, n - 7))}` : 'card'
    case 'sentence':
      return s ? quoted(cut(s, n - 2)) : 'sentence'
    case 'citation':
      return cut(c ? citeLabel(c) : 'citation', n)
    default:
      return cut(t.label || s || (c ? citeLabel(c) : t.kind), n)
  }
}
