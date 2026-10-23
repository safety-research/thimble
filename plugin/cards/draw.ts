// draw.ts: cards on screen. A card draws in a frame under the call of main's that drew its first version, or under the
// answer v was pressed on when the designer fork drew it; a new version takes its place, and a later call of the same
// card shows one line that points to it (on Claude Code's main screen, a version of a later turn stands at its own
// call, since the old place is in the terminal's scrollback: canRedraw). Inside the frame, the one Client module (client.tsx) draws the tree the runner made of the view. The
// person's keys and clicks go to the runner, and its new tree is drawn.
//
//   frame         the card's frame: its title, the Client, a failure, and the keys that reach it now; left of it, the
//                 margin that asks a side thread about the card (core/askcell.js: a ? under the pointer, ↳ once
//                 asked), beside the line a click selected (`▸`), about that part, else beside the title; nothing for a card the version of its answer shown now leaves out (core/answerview.ts
//                 cardHidden)
//   framesUnder   the frames of the cards drawn under an answer
//   askCard       a request to the runner about a card; a card the runner does not hold is loaded from its copy first
//   applyAnswer   the runner's answer to an event: the new tree on screen, the state on disk, a failure said
//   noteShown     which of a row's cards the screen shows now, from the row's `onScreen` and each card's height
//   keyOwner      the card a key at an empty prompt goes to: among the cards the screen shows, the focused card when it
//                 lists the key, else the newest that lists it
//   cardTake      a letter at an empty prompt that a card takes (hooks/keys.ts asks): the key at once, and its undo when
//                 the person was typing a word
//   cardPost      what a card's Client sends: Button presses and clicks
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
import { cardAsk, cardHidden, underCard } from '../core/answerview'
import { askCell } from '../core/askcell.js'
import { cut } from '../core/text.js'
import { themeNow, type Theme } from '../core/theme'
import { mainTurn } from '../core/turn'
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

/** Whether Claude Code can still draw a card again that main drew in `turn`: always in the fullscreen layout; on the
 *  main screen only while that turn runs, since the main screen says nothing of which rows have scrolled away. */
export async function canRedraw($: Engine, turn: string | undefined): Promise<boolean> {
  return fullscreen === true || (!!turn && turn === (await mainTurn($)))
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

/** Which of the cards at the end of a row (its frames, the last first counted from the row's end) the screen shows
 *  now: the row's `onScreen` names the rows of it in the viewport, null when none is. A card shows when one of its
 *  frame's rows is in the viewport; a card whose height is not known yet takes the whole row. When the cards the
 *  screen shows change, every card's frame draws again, since the keys each names depend on the others. */
export function noteShown($: Engine, ids: string[], onScreen: { first: number; last: number; of: number } | null | undefined): void {
  let changed = false
  let end = onScreen?.of ?? 0
  for (const id of [...ids].reverse()) {
    let now = true
    if (onScreen === null) now = false
    else if (onScreen) {
      const h = heights.get(id)
      const start = h ? end - h - FRAME_ROWS : 0
      now = onScreen.last >= start && onScreen.first < end
      end = start
    }
    if (shown.get(id) !== now) { shown.set(id, now); changed = true }
  }
  if (changed) $.clock.after(0, () => $.ui.invalidate('ui.render'))
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

/** The card's frame: title, the Client that draws its tree, a failure, and the keys that reach it now; under it, what
 *  the features put under a card. `o.layout`: the width the card is laid out at when that is wider than the frame
 *  (a copy in the side pane is the conversation's drawing, cut at the frame's edge, so no row of it wraps). */
export async function frame($: Engine, e: Any, meta: CardMeta, o: { layout?: number } = {}): Promise<Any> {
  const E = $.ui.resolve(e) as Any
  // a card the version of its answer shown now leaves out (a squeeze's): nothing in its place
  if (await cardHidden($, meta.id)) return E.Box({ key: `frame-${meta.id}`, flexDirection: 'column', children: [] })
  const inside = cardWidth(e.viewport?.columns)
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
  const client = E.Client({ key: clientKey(meta), module: './client.tsx', width, props: propsAt(meta, t, width, theme) })
  const rows: Any[] = [
    E.Text({ key: 'title', bold: true, wrap: 'wrap', children: meta.title }),
    // a drawing wider than the frame: its columns past the frame's edge are cut
    ...(fault ? [] : [width > inside ? E.Box({ key: 'cut', flexDirection: 'column', width: inside, overflow: 'hidden', children: [client] }) : client]),
  ]
  if (fault) rows.push(E.Text({ key: 'fault', color: 'error', wrap: 'wrap', children: `× Claude Code could not draw this card: ${fault}` }))
  if (meta.error && !failedElsewhere) rows.push(E.Text({ key: 'error', color: 'error', wrap: 'wrap', children: `× ${meta.error}` }))
  // the line a click or a key selected (`▸`, the card guide's marker): the margin asks about that part of the card,
  // beside it, so a click on a bar and one on the ? next to it start a thread about the bar
  const sel = fault ? null : selectedLine(current?.tree, width)
  const ask = await cardAsk($, meta.id, meta.title, sel?.text ?? '')
  const titleRows = Math.max(1, Math.ceil(Array.from(meta.title).length / Math.max(1, inside)))
  const box = E.Box({ key: `frame-${meta.id}`, flexDirection: 'column', borderStyle: 'round', borderColor: focused ? 'text' : undefined, borderDimColor: !focused, paddingX: 1, marginLeft: ask ? 0 : 2, width: inside + 4, children: rows })
  // the margin left of the frame, in the 2 columns of its indent, beside its title: asks a side thread about the card
  // (its title and what it shows); the row's keyed Box scopes the ?'s hover, so it shows while the pointer is on the card
  const framed = ask
    ? E.Box({ key: `ask-row-${meta.id}`, flexDirection: 'row', children: [E.Box({ width: 2, flexShrink: 0, paddingTop: 1 + (sel ? titleRows + sel.row : 0), children: [askCell(E, { key: `card-ask-${meta.id}`, ...ask })] }), box] })
    : box
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

/** A card's text copy as it draws now: what its newest version shows, at the width it is drawn at. */
export async function cardText($: Engine, id: string): Promise<string> {
  const meta = await metaOf($, id)
  if (!meta || meta.version < 1) return ''
  const t = await treeOf($, id)
  const r = await askCard($, meta, 'copy', { width: t?.width ?? cardWidth() })
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
  const row = meta.anchorRow ?? meta.toolUseId
  try {
    void Promise.resolve($.ui.scroll({ to: { requestId: row }, block: meta.anchorRow && block === 'start' ? 'end' : block })).catch(() => undefined)
  } catch { /* nothing moves */ }
}

/** The cards an answer row holds, framed, under it: those still anchored there (on the main screen, a version main
 *  draws of such a card in a later turn stands at main's call: canRedraw). */
export async function framesUnder($: Engine, e: Any): Promise<Any[]> {
  const metas: CardMeta[] = []
  for (const id of await anchoredAt($, e.requestId)) {
    const meta = await metaOf($, id)
    if (meta && meta.version > 0 && meta.anchorRow === e.requestId) metas.push(meta)
  }
  if (metas.length) noteShown($, metas.map(m => m.id), e.props?.onScreen)
  const out: Any[] = []
  for (const meta of metas) out.push(await frame($, e, meta))
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
  if (typeof ev.rows === 'number') { heights.set(meta.id, ev.rows); return null }
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
  return { tree: d?.tree ?? null, width: room, need: needOf(meta, d, room, theme) }
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
