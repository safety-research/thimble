// pane.ts: thimble's one side pane. openPane shows a kind of pane with its arguments in place of what the pane showed,
// and closePane closes it. One `ui.render` hook draws the pane, by the kind it shows, with the drawing's elements:
//
//   evidence   ../marks/evidence.tsx    one mark's evidence
//   labels     ../labels/pane.tsx       the folder's labels and their records
//   coverage   ../panes/coverage.tsx    what Claude read of the folder
//   settings   ../panes/settings.tsx    the three switches
//   claims     ../claims/seam.ts        the conversation's claims (c)
//   threads    ../threads/seam.ts       the side threads (t)
//   thread     ../threads/seam.ts       one side thread: what it is about, its turns, its input
//
// Under the evidence, labels, coverage and claims panes stands the pane's side thread (threads/seam.ts threadUnder):
// its conversation and an input bar that asks it about what the pane shows, as 0.10's side panel had under each pane.
//
// The way back: the pane keeps a trail of the panes it showed before this one (trail.mjs). A pane opened while the
// pane is open goes on top of it (a citation opened from a side answer stands over that answer); the row at the top
// says where back goes (`‹ back to claim`), and a click on it goes back, as esc does: Claude Code closes a pane on esc
// (and on its close mark), and while the trail holds a pane the ui.close hook goes back to it instead. On the trail's
// first pane esc closes the pane. The same row has `× close` at its right, in the look the tray's close has, which
// closes the pane whatever the trail holds.
//
// Docked beside the conversation, the pane keeps its input bar and its key row at its bottom: the drawing above them
// gets the rows left over (a pane that lays itself out reads them as its `bodyRows`), the side thread's conversation
// follows it, and when the two are taller than that room they scroll in it with the wheel and ↑ ↓ (the ui.scroll
// hook), the end shown when the conversation grows. In a pane whose drawing fits, ↑ and ↓ press the
// pane's k and j (the previous and next claim, the coverage row above or below): Claude Code gives a plugin no arrow
// keys of its own, but sends ↑ and ↓ in a pane that can scroll as scrolls, and a row under the frame that is never
// shown keeps the pane scrollable.
//
// (Each kind's draw is imported and called by name: Claude Code follows `$` only into functions a file declares or
// imports, so a list of draws that take `$` cannot be called from here.)
import type { EngineInterface, Register } from 'claude-code'

import { failCleared, failLineNow } from '../bar/notice'
import { drawClaimsPane } from '../claims/seam'
import { drawLabels } from '../labels/pane'
import { drawEvidence } from '../marks/evidence'
import { drawCoverage } from '../panes/coverage'
import { drawSettings } from '../panes/settings'
import { drawThreadsPane, threadPaneParts, threadUnderSplit } from '../threads/seam'
import { quiet } from './askcell.js'
import { cut } from './text.js'
import { accent } from './theme'
import { crumbOf, nextTrail, treeRows } from './trail.mjs'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

export const PANE_ID = 'thimble'
const NOW = { plugin: 'thimble', key: 'pane' } as const

/** A pane the trail keeps: its kind and arguments, the title it was opened with, the rows it asked for. */
export type PaneEntry = { kind: string; args: unknown; title: string; rows?: number }
export type PaneNow = { kind: string; args: unknown; title?: string; escape?: boolean; rows?: number; trail?: PaneEntry[] }

/** `focus`: the person opened it (a key, a click, a command), so it takes the keyboard and Esc closes it. Answers
 *  whether the pane is on screen; once it is, the notice that said the side pane could not open (`pane:…`) goes.
 *  Claude Code places a pane at any width only when the person's own command, prompt or click opened it; a key at the
 *  prompt is none of these, so below 144 columns (110 once the person opened the pane before) the pane would wait
 *  unseen until the terminal grows. Such a pane is closed, and the caller says why. */
/** Claude Code sets `closeOnEscape` and `rows` anew on each open, so an open that only redraws the pane with other
 *  arguments (a key in it: j, v, a page) keeps those the open pane has; else Esc would stop closing it after one key.
 *  The pane shown before goes on the trail, or this one takes its place (trail.mjs nextTrail). */
export async function openPane($: Engine, kind: string, args: unknown, title: string, o: { focus?: boolean; rows?: number } = {}): Promise<boolean> {
  const was = await paneNow($)
  const open = was ? await isOpen($) : false
  const escape = Boolean(o.focus || (open && was?.escape))
  const rows = o.rows ?? (open && was?.kind === kind ? was?.rows : undefined)
  const trail = nextTrail(was, open, kind, args) as PaneEntry[]
  await $.state.set(NOW, { kind, args, title, ...(escape ? { escape } : {}), ...(rows ? { rows } : {}), ...(trail.length ? { trail } : {}) })
  const r = await $.ui.open({ id: PANE_ID, title, ...(o.focus ? { focus: true } : {}), ...(escape ? { closeOnEscape: true } : {}), ...(rows ? { rows } : {}) })
  if (r.isPlaced) {
    // the line that said the side pane could not open (a narrow terminal: `pane:<kind>`) goes once it is open, on
    // whatever it shows (/threads opens a thread a key asked for on its citation's evidence)
    const line = await failLineNow($)
    if (line?.about?.startsWith('pane:')) await failCleared($, line.about)
    return true
  }
  await closePane($)
  return false
}

/** Back down the trail: to its pane `to` (an index into it; the last one when left out), the panes over it gone. False
 *  when the trail is empty (the pane is on its first pane). The pane takes the keyboard: the person moves in it. */
export async function paneBack($: Engine, to?: number, o: { later?: boolean } = {}): Promise<boolean> {
  const now = await paneNow($)
  const trail = now?.trail ?? []
  if (!now || !trail.length) return false
  const i = to == null ? trail.length - 1 : Math.max(0, Math.min(trail.length - 1, to))
  const e = trail[i]!
  const rest = trail.slice(0, i)
  await $.state.set(NOW, { kind: e.kind, args: e.args, title: e.title, escape: true, ...(e.rows ? { rows: e.rows } : {}), ...(rest.length ? { trail: rest } : {}) })
  const open = () => $.ui.open({ id: PANE_ID, title: e.title, focus: true, closeOnEscape: true, ...(e.rows ? { rows: e.rows } : {}) })
  // inside Claude Code's close (esc) the pane is closing, so the open that retitles it and gives it the keyboard back
  // waits until that close was refused
  if (o.later) $.clock.after(0, () => { void open().catch(() => undefined) })
  else await open()
  return true
}

/** Whether thimble's pane is open (the person may have closed it); open when Claude Code cannot say. */
async function isOpen($: Engine): Promise<boolean> {
  try { return (await $.ui.panes()).some(p => p.id === PANE_ID) } catch { return true }
}

export async function closePane($: Engine): Promise<void> {
  await $.state.set(NOW, null)
  await $.ui.close({ id: PANE_ID })
}

export async function paneNow($: Engine): Promise<PaneNow | null> {
  return ((await $.state.get(NOW)).value ?? null) as PaneNow | null
}

/** A /clear or a /resume (hooks/turnover.ts): a pane on the earlier conversation's records closes (thimble's settings
 *  are no conversation's). */
export async function turnPane($: Engine): Promise<void> {
  const now = await paneNow($)
  if (now && now.kind !== 'settings') await closePane($)
}

// ------------------------------------------------------------------------------------------------ the drawing

/** The kinds whose drawing leaves room for the side thread under it itself (they read threads/seam.ts rowsUnder):
 *  they get the pane's rows less the top row only. */
const OWN_ROOM = new Set(['labels', 'coverage'])
/** The kinds with a side thread under them. */
const THREADED = new Set(['evidence', 'labels', 'coverage', 'claims'])

/** The last drawing's layout, for the ui.scroll hook: which pane, whether its input bar is pinned to its bottom, how
 *  many rows of its drawing do not fit, and the keys its Buttons press. */
let laid: { id: string; pinned: boolean; over: number; keys: Map<string, () => unknown> } | null = null
/** How far the drawing above the input bar is scrolled, in the pane it was scrolled in. */
let scrolled = { id: '', by: 0, conv: 0 }

/** The pane's columns at its last drawing, or 0 before one: the width a copy of it is drawn at (paneDrawing). */
let paneColumns = 0

/** `els` whose Buttons note their hotkeys and presses in `keys`, so ↑ and ↓ can press k and j. */
function noting(els: Any, keys: Map<string, () => unknown>): Any {
  const Button = (p: Any) => {
    if (p && typeof p.hotkey === 'string' && typeof p.onPress === 'function') keys.set(p.hotkey, p.onPress)
    return els.Button(p)
  }
  // over an object of its own: Claude Code's table is frozen, and the fixer's plain elements make any name an element
  return new Proxy({}, { get: (_t, k) => (k === 'Button' ? Button : els[k]) })
}

/** The kind's own drawing, in `room` rows. */
async function drawKind($: Engine, e: Any, now: PaneNow, els: Any, room: number): Promise<unknown> {
  const er = { ...e, props: { ...(e?.props ?? {}), scroll: { ...(e?.props?.scroll ?? {}), bodyRows: room } } }
  if (now.kind === 'evidence') return drawEvidence($, er, now.args, els)
  if (now.kind === 'labels') return drawLabels($, er, now.args, els)
  if (now.kind === 'coverage') return drawCoverage($, er, now.args, els)
  if (now.kind === 'settings') return drawSettings($, er, now.args, els)
  if (now.kind === 'claims') return drawClaimsPane($, er, now.args, els)
  if (now.kind === 'threads' || now.kind === 'thread') return drawThreadsPane($, er, now.kind, now.args, els)
  return els.Text({ dimColor: true, children: `thimble has no pane ${now.kind}.` })
}

/** The top row: `‹ back to <the pane under this one>` while the trail holds a pane, and `× close` at its right, bold in
 *  thimble's color as the tray's close is. */
function topRow($: Engine, els: Any, now: PaneNow, W: number): Any[] {
  const { Box, Button, Text } = els
  const trail = now.trail ?? []
  const under = trail[trail.length - 1]
  const back = under
    ? Button({ key: 'pane-back', plain: true, label: 'back', hover: quiet('pane-back'), onPress: () => paneBack($), children: [Text({ color: accent(), wrap: 'truncate-end', children: `‹ back to ${cut(crumbOf(under.kind, under.args).words, Math.max(8, W - 22))}` })] })
    : null
  const close = Button({ key: 'pane-close', plain: true, label: 'close the pane', hover: quiet('pane-close'), onPress: () => closePane($), children: [Text({ color: accent(), bold: true, children: '× close' })] })
  return [Box({ key: 'pane-top', flexDirection: 'row', justifyContent: 'space-between', width: W, children: [
    Box({ key: 'pane-top-left', flexDirection: 'row', flexShrink: 1, children: back ? [back] : [] }),
    Box({ key: 'pane-top-right', flexDirection: 'row', flexShrink: 0, marginLeft: 2, children: [close] }),
  ] })]
}

/** The pane's name for its scroll: another pane starts at its top. */
const idOf = (now: PaneNow) => `${now.kind}:${JSON.stringify(now.args ?? null)}`

/** What the pane shows now, drawn with `els`: Claude Code's elements when it draws the pane, or plain ones when the
 *  fixer gets a text copy of the screen (fix/screen.ts). */
export async function drawPane($: Engine, e: Any, now: PaneNow | null, els: Any): Promise<unknown> {
  try {
    if (!now) return els.Text({ dimColor: true, children: 'Nothing is open here.' })
    const W = Math.max(20, Number(e?.props?.bodyColumns) || 80)
    const H = Math.max(8, Number(e?.props?.scroll?.bodyRows) || 40)
    // docked, the frame is the pane's whole height and the input bar stays at its bottom; inline the frame fits the tree
    const pinned = e?.props?.placement === 'dock'
    const keys = new Map<string, () => unknown>()
    const kels = noting(els, keys)
    const top = topRow($, els, now, W)
    const T = top.length ? treeRows(top, W) : 0
    // the drawing, then the side thread's conversation under it (both scroll in the room left), then the thread's key row
    // and input bar (`under`, kept at the bottom)
    let under: Any[] = []
    let conv: Any[] = []
    let drawn: unknown
    if (now.kind === 'thread') {
      // a thread's own key row and input bar stand where a pane's thread's do
      const p = await threadPaneParts($, { ...e, props: { ...(e?.props ?? {}), scroll: { ...(e?.props?.scroll ?? {}), bodyRows: Math.max(4, H - T) } } }, now.args, kels)
      under = p.bottom as Any[]
      conv = p.body.slice(1) as Any[]
      drawn = p.body[0] ?? null
    } else {
      if (THREADED.has(now.kind)) {
        try { ({ conv, bottom: under } = (await threadUnderSplit($, e, now.kind, now.args, kels)) as { conv: Any[]; bottom: Any[] }) } catch { under = []; conv = [] }
      }
      drawn = await drawKind($, e, now, kels, Math.max(4, H - T - (OWN_ROOM.has(now.kind) ? 0 : treeRows(under, W))))
    }
    const U = under.length ? treeRows(under, W) : 0
    const id = idOf(now)
    if (!pinned) {
      laid = { id, pinned: false, over: 0, keys }
      const parts = [...top, drawn, ...conv, ...under]
      return parts.length === 1 ? drawn : els.Box({ flexDirection: 'column', children: parts })
    }
    // the rows above the input bar, and how far the drawing and the conversation reach past them
    const space = Math.max(1, H - T - U)
    const C = conv.length ? treeRows(conv, W) : 0
    const tall = treeRows(drawn, W) + C
    // a drawing taller than the room loses a row of it to the line that says how much more there is
    const over = tall > space ? tall - (space - 1) : 0
    // a pane opened again, or a conversation that grew (a question, an answer), shows its end, as a chat does
    if (scrolled.id !== id) scrolled = { id, by: C ? over : 0, conv: C }
    else if (C !== scrolled.conv) scrolled = { id, by: over, conv: C }
    scrolled.by = Math.max(0, Math.min(over, scrolled.by))
    laid = { id, pinned: true, over, keys }
    const left = over - scrolled.by
    const cue = over > 0 ? els.Text({ key: 'pane-more', dimColor: true, wrap: 'truncate-end', children: left > 0 ? `↓ ${left} more row${left === 1 ? '' : 's'} · scroll or ↓` : `↑ ${over} row${over === 1 ? '' : 's'} above · scroll or ↑` }) : null
    const body = els.Box({ key: 'pane-body', flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden', children: [
      els.Box({ key: 'pane-body-in', flexDirection: 'column', flexShrink: 0, ...(scrolled.by ? { position: 'relative', top: -scrolled.by } : {}), children: [drawn, ...conv] }),
    ] })
    return els.Box({ flexDirection: 'column', children: [
      els.Box({ key: 'pane-frame', flexDirection: 'column', height: H, children: [...top, body, ...(cue ? [cue] : []), ...(under.length ? [els.Box({ key: 'pane-under', flexDirection: 'column', flexShrink: 0, children: under })] : [])] }),
      // a row past the frame, never shown (this hook takes every scroll of the pane): Claude Code sends ↑ and ↓ as
      // scrolls only to a pane that can scroll
      els.Text({ key: 'pane-past', children: ' ' }),
    ] })
  } catch (err) {
    return els.Text({ color: 'error', wrap: 'wrap', children: `This pane could not be drawn (${String((err as Error)?.message || err).slice(0, 160)}). Press esc, then open it again.` })
  }
}

/** The pane as it shows now, drawn with `els` at the width it was last drawn at, or null when it is closed. */
export async function paneDrawing($: Engine, els: Any): Promise<{ kind: string; drawn: unknown } | null> {
  const now = await paneNow($)
  if (!now || !(await isOpen($))) return null
  const e = { requestId: PANE_ID, props: { bodyColumns: paneColumns || 60 } }
  return { kind: now.kind, drawn: await drawPane($, e, now, els) }
}

/** A scroll of the docked pane: the drawing above its input bar moves in its room, or, where it fits, ↑ and ↓ press
 *  k and j. Claude Code's own window stays where it is (the frame fills it). False for a pane drawn inline. */
export async function scrollPane($: Engine, e: { by?: number; origin?: { kind?: string }; pointer?: unknown }): Promise<boolean> {
  const l = laid
  if (!l?.pinned) return false
  const by = Number(e?.by) || 0
  const arrow = e?.origin?.kind === 'person' && !e?.pointer && Math.abs(by) === 1
  if (arrow && l.over === 0) {
    const press = l.keys.get(by > 0 ? 'j' : 'k')
    if (press) await Promise.resolve(press()).catch(() => undefined)
    return true
  }
  if (!by || !l.over) return true
  // a page key moves by the pane's rows, Home and End to the ends (clamped)
  const was = scrolled.id === l.id ? scrolled.by : 0
  scrolled = { ...scrolled, id: l.id, by: Math.max(0, Math.min(l.over, was + by)) }
  if (scrolled.by !== was) $.ui.invalidate('ui.render')
  return true
}

export const registerPanes: Register = on => {
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const els = $.ui.resolve(e) as Any
    const cols = Number((e as Any).props?.bodyColumns)
    if (cols > 0) paneColumns = cols
    return drawPane($, e, await paneNow($), els)
  })

  // esc, or the pane's close mark: back down the trail while it holds a pane, else closed
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    if (e.origin?.kind === 'person' && (await paneBack($, undefined, { later: true }).catch(() => false))) return undefined
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.scroll', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    if (await scrollPane($, e as Any)) return {}
    return next(e)
  }).catch(($, e, next) => next(e))
}
