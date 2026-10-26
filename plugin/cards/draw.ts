// draw.ts: cards on screen. A card draws in a frame under the call of main's that drew its first version, or under the
// answer v was pressed on when the designer fork drew it; a new version takes its place, and a later call of the same
// card shows one line that points to it (on Claude Code's main screen, a version of a later turn stands at its own
// call, since the old place is in the terminal's scrollback: canRedraw). Inside the frame, the one Client module (client.tsx) draws the tree the runner made of the view. The
// person's keys and clicks go to the runner, and its new tree is drawn.
//
//   frame         the card's frame: its title (a click asks about the card) and, at its right, `ask about this card`
//                 (the question names the item selected, when one is), the Client (a click on an item selects it as
//                 its key does; on other words, asks about them: client.tsx, runner.mjs pick), a failure; left of it, the
//                 margin that asks a side thread about the card (core/askcell.js: a ? under the pointer, ↳ once
//                 asked), beside the line a click selected (`▸`), about that part, else beside the title; nothing for a card the version of its answer shown now leaves out (core/answerview.ts
//                 cardHidden)
//   framesUnder   the frames of the cards drawn under an answer
//   askCard       a request to the runner about a card; a card the runner does not hold is loaded from its copy first
//   applyAnswer   the runner's answer to an event: the new tree on screen, the state on disk, a failure said
//   noteShown     which of a row's cards the screen shows now, from the row's `onScreen` and each card's height
//   noteFrames    where each card stands in an answer's whole drawing (core/answerview.ts), measured, for noteShown
//   keyOwner      the card a key at an empty prompt goes to: among the cards the screen shows, the focused card when it
//                 lists the key, else the newest that lists it
//   cardTake      a letter at an empty prompt that a card takes (hooks/keys.ts asks): the key at once, and its undo when
//                 the person was typing a word
//   cardPost      what a card's Client sends: Button presses, clicks, and a click on a run of words (the item on its
//                 line, else its side thread)
//   cardText      a card's text copy as it draws now (for v)
//   revealCard    the card's row brought into view in the conversation
//
// The width a card is drawn at is the screen's columns less its frame. A drawing hook may not write the session's
// state, so when the frame has no drawing at its width (a resumed session, a resize, a side pane that opens or closes)
// or for the theme (core/theme.ts: the view's surface.colors give one set for each), its Client asks for one
// (client.tsx), and that request draws it; the Client also says when the card is first on screen. A card keeps a
// drawing for each width and theme it shows at (the conversation, its copy in a side pane: store.ts withDrawing), and a
// frame draws only the one laid out at its own width. So is the answer to a Client's post: the drawing at the width the
// Client's frame draws at now (siteWidth), never at the width the post named. A post the Client sent before its frame
// narrowed (a side pane opened) can be answered after the frame's new drawing came, and the wider drawing it named
// would then stay in the narrower frame, each row's last column wrapped onto a line of its own.
import type { EngineInterface } from 'claude-code'

import { failCleared, failNotice } from '../bar/notice'
import { cardAsk, cardHidden, textView, underCard } from '../core/answerview'
import { quiet } from '../core/askcell.js'
import { cut } from '../core/text.js'
import { rowsAt, rowsKnown, treeRows } from '../core/trail.mjs'
import { accent, themeNow, type Theme } from '../core/theme'
import { mainTurn } from '../core/turn'
import { cardRef } from '../marks/message.js'
import { citeTint } from '../marks/view'
import { featureOn } from '../settings/features.mjs'
import { ask } from './ask'
import { layoutLines } from './layout.js'
import { type CardDrawing, type CardMeta, type CardTree, anchoredAt, drawingAt, focusNow, keptFocus, keptMeta, keptSeen, markSeen, metaOf, readState, saveMeta, saveState, setFocus, setTree, treeOf, versionDir } from './store'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Columns the frame takes beside the card: its indent (2), border (2) and padding (2), and 2 left free at the right. */
const FRAME = 8
const MIN_WIDTH = 20

/** Rows a card's frame adds to its Client's: the title, a line under it, the keys' line and the two borders. */
const FRAME_ROWS = 5

let columnsSeen = 0
let rowsSeen = 0
// whether the terminal draws the conversation in its fullscreen layout, where every row can be drawn again; on the main
// screen a row that has scrolled into the terminal's own scrollback stays as it was printed. Not known until a drawing
// says (after a reload of the plugin), and then read as the main screen
let fullscreen: boolean | undefined
// the rows each card's Client takes, as it last reported them, and whether the screen shows each card now (a surface
// that does not say where its rows are leaves a card out: then every card drawn takes keys)
const heights = new Map<string, number>()
const shown = new Map<string, boolean>()
// the trees Claude Code's Client could not draw, by card: the version (gen) and the runner's answer the tree came
// from, and why. The frame says why in the card's place until the card has a newer tree or a new version, which is
// drawn again.
const faulted = new Map<string, { gen: number; seq: number; reason: string }>()
// the width each frame of a card draws at now, by the drawing it stands in (the `requestId` of its row or pane, which
// a Client's ui.message names too) and the card: what the answer to that Client's post is laid out at
const siteWidth = new Map<string, number>()
const siteOf = (site: unknown, id: string) => `${String(site ?? '')}\u0000${id}`

/** The screen's size and layout, as the last drawing of a message or a card saw it. */
export function noteViewport(v: { columns?: number; rows?: number; isFullscreen?: boolean } | undefined): void {
  if (v?.columns && v.columns > 0) columnsSeen = v.columns
  if (v?.rows && v.rows > 0) rowsSeen = v.rows
  if (typeof v?.isFullscreen === 'boolean') fullscreen = v.isFullscreen
}

/** Whether the last drawing saw the fullscreen layout (undefined: none said yet). */
export const fullscreenNow = (): boolean | undefined => fullscreen

/** Whether Claude Code can still draw a card again that main drew in `turn`: always in the fullscreen layout; on the
 *  main screen only while that turn runs, since the main screen says nothing of which rows have scrolled away. */
export async function canRedraw($: Engine, turn: string | undefined): Promise<boolean> {
  return fullscreen === true || (!!turn && turn === (await mainTurn($)))
}

// Claude Code keeps the newest run of reads and commands live (ToolGroup isActive: its line and the rows of its last
// call) until its next request after the card's call, and only then folds it into one line. A card drawn under its call
// at once stood that many rows lower and jumped up a moment later, so the first drawing of a card of the turn that runs
// waits while a run is live (firstWaits); it draws when the run folds, the next step starts or the turn ends (runFolded).
// The runs live now, by row; the cards that wait; the cards drawn since the plugin loaded.
const liveRuns = new Set<string>()
const waiting = new Set<string>()
const drawnOnce = new Set<string>()

/** A run of calls drawn now (`row`, its requestId): live or folded. */
export function noteRun($: Engine, row: string, live: boolean): void {
  if (live) liveRuns.add(row)
  else if (liveRuns.delete(row)) runFolded($)
}

/** No run is live any more (`all`: a step of main's started, or its turn ended), or one folded: the cards that waited
 *  draw. */
export function runFolded($: Engine, all = false): void {
  if (all) liveRuns.clear()
  if (!waiting.size || liveRuns.size) return
  waiting.clear()
  $.clock.after(0, () => $.ui.invalidate('ui.render'))
}

/** Whether the card's frame waits: its first drawing, of a card main's running turn drew, while a run is live. */
export async function firstWaits($: Engine, meta: CardMeta): Promise<boolean> {
  if (drawnOnce.has(meta.id)) return false
  if (liveRuns.size && !!meta.turn && meta.turn === (await mainTurn($))) {
    waiting.add(meta.id)
    return true
  }
  drawnOnce.add(meta.id)
  return false
}

/** The screen's rows, or 0 while no drawing said. */
export function screenRows(): number {
  return rowsSeen
}

/** The screen's columns, or 0 while no drawing said. */
export function screenColumns(): number {
  return columnsSeen
}

export function cardWidth(columns?: number): number {
  return Math.max(MIN_WIDTH, (columns || columnsSeen || 100) - FRAME)
}

/** The share of the window's columns Claude Code leaves the conversation beside a side pane (2.1.307: 88 of 160). */
const BESIDE_PANE = 0.55

/** The width a card is drawn at while a side pane narrows the conversation (a thread, the tray). */
export function cardWidthBesidePane(): number {
  return cardWidth(Math.round((columnsSeen || 100) * BESIDE_PANE))
}

const about = (id: string) => `card:${id}`

/** The key of a card's Client: one per version, so a new version is a new instance, and a Client that failed on an
 *  earlier version (Claude Code draws a failed instance again only after a reload) does not stay in its place. */
export const clientKey = (meta: CardMeta) => `card-${meta.id}-${meta.gen}`
/** The card and version a Client key names, as ui.message and ui.fault give it. */
export const cardOfKey = (key: string) => { const [, id, gen] = String(key).split('-'); return { id: id ?? '', gen: gen === undefined ? null : Number(gen) } }

/** Load a card's version on screen into the runner, from its copy on disk. */
async function loadCard($: Engine, meta: CardMeta, width: number): Promise<Any> {
  const dir = await versionDir($, meta.id, meta.version)
  let view = ''
  try { view = String(await $.fs.read(`${dir}/view.js`)) } catch { return { ok: false, error: `the copy of “${meta.title}” is gone (${dir})` } }
  return ask($, 'load', { id: meta.id, version: meta.version, title: meta.title, view, rows: `${dir}/rows.json`, state: await readState($, meta.id, meta.version), width })
}

/** A request about a card: when the runner does not hold the card (it started again, the session was resumed), the
 *  card is loaded from its copy and the request asked again. */
export async function askCard($: Engine, meta: CardMeta, op: string, body: Record<string, unknown>): Promise<Any> {
  const r = await ask($, op, { id: meta.id, ...body })
  if (!r?.missing) return r
  const width = Number(body.width) || ((await treeOf($, meta.id))?.width ?? cardWidth())
  const loaded = await loadCard($, meta, width)
  if (!loaded.ok) return loaded
  return op === 'draw' ? loaded : ask($, op, { id: meta.id, ...body })
}

/** The runner's answer to an event of the person's, or to a drawing at a new `width`: the new tree drawn, the state
 *  kept, and a failure line about the card gone; a failure on the card and in the failure line, since the person sees
 *  the card stop. The runner keeps the card as it was before a failure (its state, width and keys), so a drawing that
 *  failed at one width holds only there: at another width the card draws again (frame). */
export async function applyAnswer($: Engine, meta: CardMeta, r: Any, width?: number, drawing = false): Promise<void> {
  if (r?.ok) {
    const before = await treeOf($, meta.id)
    await setTree($, meta.id, { gen: meta.gen, width: width ?? before?.width ?? cardWidth(), tree: r.tree, seq: Number(r.seq) || 0, theme: await themeNow($) }, !drawing)
    if (typeof r.state === 'string') void saveState($, meta.id, meta.version, r.state).catch(() => undefined)
    if (meta.error) await saveMeta($, { ...meta, error: null, errorWidth: null })
    await failCleared($, about(meta.id))
    return
  }
  const shown = (await treeOf($, meta.id))?.width
  const error = drawing && width
    ? `at ${width} columns the view failed (${String(r?.error || 'no answer')}); the card shows its drawing at ${shown ?? 'its last'} columns, and draws again when its width changes`
    : String(r?.error || 'the card did not answer')
  await saveMeta($, { ...meta, error, errorWidth: drawing && width ? width : null })
  failNotice($, `The card “${cut(meta.title, 40)}” failed: ${error}`, about(meta.id))
}

/** Which of a row's cards the screen shows now: the row's `onScreen` names the rows of it in the viewport, null when
 *  none is. `at` gives where a card was measured to stand (noteFrames): its rows, and how many rows of the row are
 *  below its top (a card placed on a line of the text stands inside it); the others are the cards at the end of the
 *  row, the last first counted from its end. A card shows when one of its frame's rows is in the viewport; a card
 *  whose height is not known yet takes the whole row. When the cards the screen shows change, every card's frame draws
 *  again, since the keys each names depend on the others. */
export function noteShown($: Engine, ids: string[], onScreen: { first: number; last: number; of: number } | null | undefined, at?: Map<string, { fromEnd: number; rows: number }>): void {
  let changed = false
  let end = onScreen?.of ?? 0
  for (const id of [...ids].reverse()) {
    let now = true
    if (onScreen === null) now = false
    else if (onScreen) {
      const h = heights.get(id)
      const m = at?.get(id)
      if (m) {
        const top = onScreen.of - m.fromEnd
        now = onScreen.last >= top && onScreen.first < top + m.rows
      } else {
        const start = h ? end - h - FRAME_ROWS : 0
        now = onScreen.last >= start && onScreen.first < end
        end = start
      }
    }
    if (shown.get(id) !== now) { shown.set(id, now); changed = true }
  }
  if (changed) $.clock.after(0, () => $.ui.invalidate('ui.render'))
}

/** The cards an answer's drawing holds (`tree`, the whole row as its hooks drew it at `width` cells): where each card
 *  stands in it, measured (core/trail.mjs rowsAt), for noteShown. A card placed on a line of the text, and a card
 *  under an answer with a catch-up below it, stand inside the row, not at its end. Each is measured from the row's
 *  end: what stands after a card is thimble's drawing, which treeRows measures, while the text above it may be
 *  Claude Code's own. */
export function noteFrames($: Engine, tree: Any, width: number, onScreen: { first: number; last: number; of: number } | null | undefined): void {
  const keyOf = (n: Any) => String(n?.key ?? n?.props?.key ?? '')
  // a frame with nothing in it is a card the version shown leaves out
  const found = rowsAt(tree, width, (n: Any) => keyOf(n).startsWith('frame-') && (n.children ?? n.props?.children ?? []).length > 0) as { el: Any; row: number }[]
  if (!found.length) return
  const total = treeRows(tree, width)
  const at = new Map<string, { fromEnd: number; rows: number }>()
  for (const f of found) {
    const id = keyOf(f.el).slice('frame-'.length)
    if (!at.has(id)) at.set(id, { fromEnd: total - f.row, rows: treeRows(f.el, width) })
  }
  noteShown($, [...at.keys()], onScreen, at)
}

/** The card a key at an empty prompt goes to: among the cards on screen, the focused card when it lists the key, else
 *  the newest that lists it; null when no card does, and the key is typed. A card is on screen when its frame was
 *  drawn since the plugin loaded and the screen shows it now (noteShown), so a card scrolled out of view, and one a
 *  resumed session no longer shows, takes no keys. */
export async function keyOwner($: Engine, key: string): Promise<CardMeta | null> {
  // a key press reads what cards/store.ts keeps of the cards, no state
  const metas: CardMeta[] = []
  for (const id of await keptSeen($)) {
    if (shown.get(id) === false) continue
    const m = await keptMeta($, id)
    if (m && m.version > 0 && m.keys.includes(key)) metas.push(m)
  }
  const focus = await keptFocus($)
  return metas.find(m => m.id === focus) ?? metas.sort((a, b) => b.at - a.at)[0] ?? null
}

/** What j and k do on a card, found once per version by pressing them in the runner, which leaves the card as it was
 *  (act): by its ▸ (the card guide's marker), the way each moves it, down or up; else `step` when each changes the card
 *  and the other takes it back (a card of steps). Null while that is not known, or for keys that do neither. */
type Steps = Record<string, 'down' | 'up' | 'step'>
const stepsKnown = new Map<string, { gen: number; dir: Steps | null }>()
const stepsAsked = new Set<string>()

async function stepsOf($: Engine, meta: CardMeta): Promise<Steps | null> {
  const known = stepsKnown.get(meta.id)
  if (known && known.gen === meta.gen) return known.dir
  const once = `${meta.id}:${meta.gen}`
  if (stepsAsked.has(once)) return null
  stepsAsked.add(once)
  void (async () => {
    const width = (await treeOf($, meta.id))?.width ?? cardWidth()
    const at = (c: Any) => (Array.isArray(c?.lines) ? (c.lines as string[]).findIndex(l => l.includes('▸')) : -1)
    const start = await askCard($, meta, 'copy', { width })
    const order = ['j', 'k', 'k', 'j'].filter(k => meta.keys.includes(k))
    const r = order.length ? await askCard($, meta, 'act', { width, actions: order.map(key => ({ key })) }) : null
    const copies = [start, ...((r?.copies ?? []) as Any[])]
    const rows = copies.map(at)
    const texts = copies.map(c => (Array.isArray(c?.lines) ? (c.lines as string[]).join('\n') : null))
    const dir: Steps = {}
    order.forEach((k, i) => {
      const a = rows[i]!
      const b = rows[i + 1]!
      if (!dir[k] && a >= 0 && b >= 0 && a !== b) dir[k] = b > a ? 'down' : 'up'
    })
    // j then k: the card changed and came back, so the two step it one way and back
    if (!dir.j && !dir.k && order.join('') === 'jkkj' && texts[0] !== null && texts[1] !== texts[0] && texts[2] === texts[0]) { dir.j = 'step'; dir.k = 'step' }
    stepsKnown.set(meta.id, { gen: meta.gen, dir: Object.keys(dir).length ? dir : null })
    $.ui.invalidate('ui.render')
  })().catch(() => stepsKnown.set(meta.id, { gen: meta.gen, dir: null }))
  return null
}

/** The keys of the card that takes them now (keyOwner), for the bar: j and k by the way they move the ▸ (`j down`,
 *  `k up`) or through steps (`j k step`), and the card's other letters together (`f g card keys`). None when no card on screen takes a key. */
export async function cardKeyWords($: Engine): Promise<{ key: string; words: string }[]> {
  const metas: CardMeta[] = []
  for (const id of await keptSeen($)) {
    if (shown.get(id) === false) continue
    const m = await keptMeta($, id)
    if (m && m.version > 0 && m.keys.length) metas.push(m)
  }
  if (!metas.length) return []
  const focus = await keptFocus($)
  const meta = metas.find(m => m.id === focus) ?? metas.sort((a, b) => b.at - a.at)[0]!
  const dir = await stepsOf($, meta)
  const steps = meta.keys.filter(k => dir?.[k] === 'step')
  const out = steps.length ? [{ key: steps.join(' '), words: 'step' }] : []
  out.push(...meta.keys.filter(k => dir?.[k] && dir[k] !== 'step').map(k => ({ key: k, words: dir![k]! as string })))
  const rest = meta.keys.filter(k => !dir?.[k])
  if (rest.length) out.push({ key: rest.join(' '), words: 'card keys' })
  return out
}

/** The card's frame: title, the Client that draws its tree, a failure, and the keys that reach it now; under it, what
 *  the features put under a card. `o.layout`: the width the card is laid out at when that is wider than the frame
 *  (a copy in the side pane is the conversation's drawing, cut at the frame's edge, so no row of it wraps). */
export async function frame($: Engine, e: Any, meta: CardMeta, o: { layout?: number; indent?: number } = {}): Promise<Any> {
  const E = $.ui.resolve(e) as Any
  // a card the version of its answer shown now leaves out (a squeeze's): nothing in its place
  if (await cardHidden($, meta.id)) return E.Box({ key: `frame-${meta.id}`, flexDirection: 'column', children: [] })
  // `indent`: columns the drawing that holds the card takes on its left beyond an answer's (a catch-up's rule)
  const inside = cardWidth(e.viewport?.columns ? e.viewport.columns - (o.indent ?? 0) : undefined)
  const width = Math.max(inside, Math.floor(o.layout ?? 0))
  const t = await treeOf($, meta.id)
  const focused = (await focusNow($)) === meta.id
  // only a drawing laid out at this width (for this theme, else the other's until this one's comes): until one comes,
  // the Client says it is drawing
  const theme = await themeNow($)
  siteWidth.set(siteOf(e.requestId, meta.id), width)
  const current = drawingAt(t, meta.gen, width, theme)
  const f = faulted.get(meta.id)
  const fault = f && current && f.gen === current.gen && f.seq === current.seq ? f.reason : null
  // a drawing that failed at another width: the card draws again at this one
  const failedElsewhere = !!meta.errorWidth && meta.errorWidth !== width
  // the title on a line of its own, then the card
  // its rows as the Client last reported them, so what measures a drawing holding the card (a catch-up's rule) counts them
  const client = rowsKnown(E.Client({ key: clientKey(meta), module: './client.tsx', width, props: propsAt(meta, t, width, theme) }), heights.get(meta.id))
  // the line a click or a key selected (`▸`, the card guide's marker): `ask about this card` asks about that part of
  // the card, so a click on a bar and then on those words start a thread about the bar
  const sel = fault ? null : selectedLine(current?.tree, width)
  const ask = await cardAsk($, meta.id, meta.title, sel?.text ?? '')
  // the title asks about the whole card when clicked, its words underlined under the pointer
  const whole = sel ? await cardAsk($, meta.id, meta.title) : ask
  const title = E.Text({ key: 'title', bold: true, wrap: 'wrap', children: meta.title })
  const titled = whole ? E.Button({ key: 'title-ask', plain: true, label: `ask about ${whole.label}`, onPress: whole.press, hover: quiet(`card-title-${meta.id}`), children: [title] }) : title
  // at the title's right, in thimble's color, what asks a side thread about the card (the question names the item
  // selected, when one is)
  const askWords = 'ask about this card'
  const askEl = ask ? E.Button({ key: 'ask-visible', plain: true, label: `ask about ${ask.label}`, onPress: ask.press, hover: quiet(`card-ask-visible-${meta.id}`), children: [E.Text({ key: 'ask-w', color: accent(), wrap: 'truncate-end', children: askWords })] }) : null
  const rows: Any[] = [
    askEl ? E.Box({ key: 'title-row', flexDirection: 'row', justifyContent: 'space-between', children: [E.Box({ key: 'title-l', flexShrink: 1, children: [titled] }), E.Box({ key: 'title-r', flexShrink: 0, marginLeft: 2, children: [askEl] })] }) : titled,
    // a drawing wider than the frame: its columns past the frame's edge are cut
    ...(fault ? [] : [width > inside ? E.Box({ key: 'cut', flexDirection: 'column', width: inside, overflow: 'hidden', children: [client] }) : client]),
  ]
  if (fault) rows.push(E.Text({ key: 'fault', color: 'error', wrap: 'wrap', children: `× Claude Code could not draw this card: ${fault}` }))
  if (meta.error && !failedElsewhere) rows.push(E.Text({ key: 'error', color: 'error', wrap: 'wrap', children: `× ${meta.error}` }))
  // the frame in the 2 columns of its indent; `ask about this card` at its title's right is how a side thread about it
  // starts, so no ? in the margin asks the same
  const framed = E.Box({ key: `frame-${meta.id}`, flexDirection: 'column', borderStyle: 'round', borderColor: focused ? 'text' : undefined, borderDimColor: !focused, paddingX: 1, marginLeft: 2, width: inside + 4, children: rows })
  // what the features put under a card (core/answerview.ts underCard: the labels it used, what a squeeze changed)
  const under = await underCard($, E, meta.id, inside)
  return under.length ? E.Box({ key: `card-at-${meta.id}`, flexDirection: 'column', children: [framed, ...under] }) : framed
}

// the selected line of each drawing, worked out once for each tree
const selected = new WeakMap<object, Map<number, { row: number; text: string } | null>>()

/** The line of a drawing that marks the selected item with `▸`: its row in the drawing and its text; null when none
 *  does. */
function selectedLine(tree: Any, width: number): { row: number; text: string } | null {
  if (!tree || typeof tree !== 'object') return null
  let byWidth = selected.get(tree)
  if (!byWidth) selected.set(tree, (byWidth = new Map()))
  if (byWidth.has(width)) return byWidth.get(width)!
  let found: { row: number; text: string } | null = null
  try {
    const lines = layoutLines(tree, width).lines as string[]
    const row = lines.findIndex(l => l.includes('▸'))
    if (row >= 0) found = { row, text: lines[row]! }
  } catch { /* the margin stays beside the title */ }
  byWidth.set(width, found)
  return found
}

/** The card's Client failed on screen (Claude Code's ui.fault): its frame draws the reason in its place until the card
 *  has a newer tree or a new version, and the failure line says it until then. */
export async function clientFault($: Engine, key: string, reason: string): Promise<void> {
  const { id, gen } = cardOfKey(key)
  const meta = await metaOf($, id)
  const t = await treeOf($, id)
  // the Client of an earlier version, which a new version's took the place of
  if (!meta || !t || (gen !== null && gen !== meta.gen)) return
  faulted.set(id, { gen: t.gen, seq: t.seq, reason: reason.slice(0, 200) })
  $.ui.invalidate('ui.render')
  failNotice($, `The card “${cut(meta.title, 40)}” could not be drawn: ${reason.slice(0, 120)}`, about(id))
}

/** A card's text copy as it draws now: what its newest version shows, at the width it is drawn at (or `width`). */
export async function cardText($: Engine, id: string, width?: number): Promise<string> {
  const meta = await metaOf($, id)
  if (!meta || meta.version < 1) return ''
  const t = await treeOf($, id)
  const r = await askCard($, meta, 'copy', { width: width ?? t?.width ?? cardWidth() })
  return r?.ok ? (r.lines as string[]).join('\n') : `(the card did not draw: ${r?.error ?? 'no answer'})`
}

/** Bring a card into view in the conversation: the row it is drawn in (main's call of it, or the answer a designer
 *  fork drew it under), its top at the window's top (`start`), or the answer's end where the card stands. Claude Code
 *  moves a conversation row only while a hook answers the person's press, pick, prompt or command; a key at the prompt
 *  (hooks/keys.ts) is none of these, and the call then moves nothing. The move is not waited for (a key's hook, ]'s,
 *  has a short budget). It also takes the conversation off its bottom, so a side pane that opens next, which narrows
 *  the conversation and makes the rows under the card taller, leaves the card where it is. */
export async function revealCard($: Engine, id: string, block: 'start' | 'nearest' = 'nearest'): Promise<void> {
  const meta = await metaOf($, id)
  if (!meta || meta.version < 1) return
  const row = meta.anchorRow ?? meta.inRow ?? meta.toolUseId
  try {
    void Promise.resolve($.ui.scroll({ to: { requestId: row }, block: meta.anchorRow && block === 'start' ? 'end' : block })).catch(() => undefined)
  } catch { /* nothing moves */ }
}

/** The cards an answer row holds, framed, under it: those still anchored there (on the main screen, a version main
 *  draws of such a card in a later turn stands at main's call: canRedraw). A card the words the row shows place on a
 *  line of their own (a squeeze's version placing a card v drew) draws on that line instead (framesIn). */
export async function framesUnder($: Engine, e: Any): Promise<Any[]> {
  const metas: CardMeta[] = []
  const ids = await anchoredAt($, e.requestId)
  const shown = ids.length ? (await textView($, e.requestId, String(e.props?.text ?? ''))).text : ''
  const placed = new Set(shown.split('\n').map(cardRef).filter(Boolean))
  for (const id of ids) {
    const meta = await metaOf($, id)
    if (meta && meta.version > 0 && meta.anchorRow === e.requestId && !placed.has(id)) metas.push(meta)
  }
  // which of them the screen shows: the answer's drawing measures where each stands (noteFrames)
  const out: Any[] = []
  for (const meta of metas) out.push(await frame($, e, meta))
  return out
}

/** The frames of the cards a reply's text places on lines of their own (marks/message.js cardRef), by id: main's cards
 *  that have drawn. The marks' drawing of the reply draws each on its line (marks/view.ts messageEl). `here`: the rows
 *  the text stands for (a catch-up's own id), where a card placed there draws, not a line pointing to it. */
export async function framesIn($: Engine, e: Any, text: string, here: string[] = [e.requestId], o: { indent?: number } = {}): Promise<Record<string, Any>> {
  const out: Record<string, Any> = {}
    for (const line of String(text ?? '').split('\n')) {
    const id = cardRef(line)
    if (!id || out[id]) continue
    const meta = await metaOf($, id)
    if (!meta || meta.version < 1) continue
    // a card drawn under an answer (v, a squeeze's new card) draws on the line a version of that answer places it on;
    // another row's line points to it
    if (meta.anchorRow && !here.includes(meta.anchorRow)) {
      const E = $.ui.resolve(e) as Any
      out[id] = E.Box({ key: `under-${id}`, children: [E.Text({ dimColor: true, children: `↑ “${cut(meta.title, 60)}” is drawn under an earlier answer` })] })
      continue
    }
    // a card stands in one place: the newest row that placed it (or a catch-up of the replies, `<row>#cu`, drawn below
    // them); an earlier one shows a line that points there
    if (!meta.anchorRow && meta.inRow && !here.includes(meta.inRow)) {
      const E = $.ui.resolve(e) as Any
      const where = meta.inRow.endsWith('#cu') ? 'is in the catch-up below' : 'is drawn further down'
      out[id] = E.Box({ key: `moved-${id}`, children: [E.Text({ dimColor: true, children: `↓ “${cut(meta.title, 60)}” ${where}` })] })
      continue
    }
    // a card on a line of the text stands in the text's column, 2 columns in from an answer's left edge (where a card
    // drawn under the answer stands), so it is that much narrower, and keeps the 2 columns free at the right
    out[id] = await frame($, e, meta, { ...o, indent: (o.indent ?? 0) + 2 })
  }
  // which of them the screen shows: the answer's drawing measures where each stands (noteFrames)
  return out
}

// the keys in the order the person pressed them: each waits for the one before it, since the hooks of two quick keys
// run at the same time and their requests could reach the runner in the other order
let keys: Promise<unknown> = Promise.resolve()

/** One request about a key, after the requests of the keys pressed before it. */
function inOrder(work: () => Promise<void>): Promise<void> {
  const done = keys.then(work)
  keys = done.catch(() => undefined)
  return done
}

/** A letter at an empty prompt that a card on screen takes: the key reaches it at once, and the undo takes it back
 *  when the person was typing a word (hooks/keys.ts). Null when no card takes it, and it types. */
export async function cardTake($: Engine, key: string): Promise<{ card: string; now: () => Promise<unknown>; undo: () => Promise<unknown> } | null> {
  if (!featureOn('cards') || !/^\p{L}$/u.test(key)) return null
  const meta = await keyOwner($, key)
  if (!meta) return null
  const id = meta.id
  const again = async (op: string, body: Record<string, unknown>) => {
    const m = await metaOf($, id)
    if (m) await applyAnswer($, m, await askCard($, m, op, body))
  }
  return { card: id, now: () => inOrder(() => again('key', { key })), undo: () => inOrder(() => again('undo', { n: 1 })) }
}

// the last event handled, by the Client instance that sent it
const handled = new Map<string, number>()

/** One event of a Client's: the card on screen, the drawing it needs, a Button press or a click. */
async function clientEvent($: Engine, meta: CardMeta, ev: Any): Promise<Any> {
  if (ev.seen) { await markSeen($, meta.id); return null }
  if (typeof ev.rows === 'number') {
    // a new height draws again what measured the card at its old one (a catch-up's rule)
    const was = heights.get(meta.id)
    heights.set(meta.id, ev.rows)
    if (was !== ev.rows) $.clock.after(0, () => $.ui.invalidate('ui.render'))
    return null
  }
  // a click on a run of the card's words: the item on its line, as the card's keys select it (runner.mjs pick); else
  // the side thread about the run, as the margin asks about the card
  if (ev.ask && typeof ev.ask === 'object') {
    if (Array.isArray(ev.ask.path)) {
      await atWidth($, meta, Number(ev.width))
      const r = await askCard($, meta, 'pick', { path: ev.ask.path.slice(0, 64).map((x: unknown) => Math.trunc(Number(x) || 0)) })
      if (r?.ok && r.handled) { await setFocus($, meta.id); return r }
    }
    const element = { text: String(ev.ask.text ?? '').slice(0, 400), line: String(ev.ask.line ?? '').slice(0, 400) }
    const a = await cardAsk($, meta.id, meta.title, '', element)
    if (a) await Promise.resolve(a.press()).catch(() => undefined)
    return null
  }
  if (typeof ev.draw === 'string') {
    const [gen, width] = ev.draw.split(':').map(Number)
    return gen === meta.gen && width ? { width, r: await askCard($, meta, 'draw', { width }) } : null
  }
  // a press or a click on a drawing at a width the runner does not hold the card at (its copy in a side pane): the
  // runner draws it at that width first, so the Button numbers and cells are those of the drawing the person saw
  if (typeof ev.press === 'number' || (ev.pointer && typeof ev.pointer === 'object')) await atWidth($, meta, Number(ev.width))
  if (typeof ev.press === 'number') return askCard($, meta, 'press', { button: ev.press })
  if (ev.pointer && typeof ev.pointer === 'object') {
    const at = (v: Any) => ({ x: Math.trunc(Number(v?.x) || 0), y: Math.trunc(Number(v?.y) || 0) })
    return askCard($, meta, 'pointer', { down: at(ev.pointer.down), up: at(ev.pointer.up), button: String(ev.pointer.button || 'left') })
  }
  return null
}

/** The runner holds the card at `width`, the width a Client drew it at. */
async function atWidth($: Engine, meta: CardMeta, width: number): Promise<void> {
  if (!width || (await treeOf($, meta.id))?.width === width) return
  const r = await askCard($, meta, 'draw', { width })
  if (r?.ok) await applyAnswer($, meta, r, width, true)
}

/** The drawing a Client asks for: one at this width (none there, or one that failed at another width), or one in this
 *  theme's colors (the drawing it has was made for the other theme); '' when it has the one it needs. */
function needOf(meta: CardMeta, d: CardDrawing | null, width: number, theme: Theme): string {
  const failedElsewhere = !!meta.errorWidth && meta.errorWidth !== width
  if (!d || failedElsewhere) return `${meta.gen}:${width}`
  return (d.theme ?? 'dark') !== theme ? `${meta.gen}:${width}:${theme}` : ''
}

/** A Client's props in a frame `room` columns wide: the drawing laid out at that width, or none and the drawing it
 *  needs. */
function propsAt(meta: CardMeta, t: CardTree | null | undefined, room: number, theme: Theme): Any {
  const d = drawingAt(t, meta.gen, room, theme)
  return { tree: d?.tree ?? null, width: room, need: needOf(meta, d, room, theme), tint: citeTint('verified', theme), accent: accent(), theme }
}

/** A Client's post: the events it has not had an answer for, each handled once, in order. After a press or a click,
 *  the card takes the keys at an empty prompt first. Answers the Client's next props, with the last event handled, at
 *  the width its frame in `site` (the drawing the Client stands in) draws at now. */
export async function cardPost($: Engine, id: string, data: Any, site?: string): Promise<Any> {
  const meta = await metaOf($, id)
  if (!meta || meta.version < 1 || !data || typeof data !== 'object' || !Array.isArray(data.events)) return {}
  const client = String(data.client ?? '')
  const from = `${id}:${client}`
  let last = handled.get(from) ?? 0
  for (const ev of data.events) {
    const n = Number(ev?.n)
    if (!Number.isInteger(n) || n <= last) continue
    last = n
    handled.set(from, n)
    if (typeof ev?.press === 'number' || ev?.pointer) await setFocus($, id)
    const r = await clientEvent($, meta, ev)
    if (r?.r) await applyAnswer($, meta, r.r, r.width, true)
    else if (r) await applyAnswer($, meta, r)
  }
  // the props at the width the Client's frame draws at now: two Clients of a card (the conversation's, a side pane's)
  // stand in two frames; a frame not drawn since the plugin loaded answers at the width the Client drew at
  const t = await treeOf($, id)
  const now = (await metaOf($, id)) ?? meta
  const room = siteWidth.get(siteOf(site, id)) || Number(data.width) || t?.width || cardWidth()
  return t ? { props: { ...propsAt(now, t, room, await themeNow($)), ack: { [client]: last } } } : {}
}
