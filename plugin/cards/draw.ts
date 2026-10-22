// draw.ts: cards on screen. A card draws in a frame under the call of main's that drew its newest version (an earlier
// call of the same card shows one line that points to it), or under the answer v was pressed on when the designer
// fork drew it. Inside the frame, the one Client module (client.tsx) draws the tree the runner made of the view. The
// person's keys, clicks and `/` search go to the runner, and its new tree is drawn.
//
//   frame         the card's frame: its title, the Client, a failure, and the keys that reach it now
//   framesUnder   the frames of the cards drawn under an answer
//   askCard       a request to the runner about a card; a card the runner does not hold is loaded from its copy first
//   applyAnswer   the runner's answer to an event: the new tree on screen, the state on disk, a failure said
//   noteShown     which of a row's cards the screen shows now, from the row's `onScreen` and each card's height
//   keyOwner      the card a key at an empty prompt goes to: among the cards the screen shows, the focused card when it
//                 lists the key, else the newest that lists it
//   cardKey       a key at an empty prompt to its card; `/` starts a search typed in the prompt box, whose words reach
//   undoKeys      the cards undo the keys they just took (the person typed a word that starts with them)
//   searchTyped   the card as props.query at each keystroke; Enter keeps it (keepSearch), and the box is cleared when
//   keepSearch    Claude Code puts the kept words back in it (searchRestored); an empty box ends a search
//   cardPost      what a card's Client sends: Button presses and clicks
//   cardsUnder    the cards drawn under an answer (for v)
//   cardText      a card's text copy as it draws now (for v)
//
// The width a card is drawn at is the screen's columns less its frame. A drawing hook may not write the session's
// state, so when the frame has no drawing at its width (a resumed session, a resize), its Client asks for one
// (client.tsx), and that request draws it; the Client also says when the card is first on screen.
import type { EngineInterface } from 'claude-code'

import { failCleared, failNotice } from '../bar/fix'
import { ask } from './ask'
import { type CardMeta, anchoredAt, cardsAtNow, focusNow, markSeen, metaOf, readState, saveMeta, saveState, searchNow, seenNow, setFocus, setSearch, setTree, treeOf, versionDir } from './store'

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
// the rows each card's Client takes, as it last reported them, and whether the screen shows each card now (a surface
// that does not say where its rows are leaves a card out: then every card drawn takes keys)
const heights = new Map<string, number>()
const shown = new Map<string, boolean>()
// the trees Claude Code's Client could not draw, by card: the runner's answer the tree came from, and why. The frame
// says why in the card's place until the card has a newer tree, which is drawn again.
const faulted = new Map<string, { seq: number; reason: string }>()

/** The screen's size, as the last drawing of a message or a card saw it. */
export function noteViewport(v: { columns?: number; rows?: number } | undefined): void {
  if (v?.columns && v.columns > 0) columnsSeen = v.columns
  if (v?.rows && v.rows > 0) rowsSeen = v.rows
}

/** The screen's rows, or 0 while no drawing said. */
export function screenRows(): number {
  return rowsSeen
}

export function cardWidth(columns?: number): number {
  return Math.max(MIN_WIDTH, (columns || columnsSeen || 100) - FRAME)
}

const cut = (s: string, n: number) => ([...s].length <= n ? s : `${[...s].slice(0, n - 1).join('')}…`)
const about = (id: string) => `card:${id}`

/** Load a card's version on screen into the runner, from its copy on disk. */
async function loadCard($: Engine, meta: CardMeta, width: number): Promise<Any> {
  const dir = await versionDir($, meta.id, meta.version)
  let view = ''
  try { view = String(await $.fs.read(`${dir}/view.js`)) } catch { return { ok: false, error: `the copy of “${meta.title}” is gone (${dir})` } }
  const { state, query } = await readState($, meta.id, meta.version)
  return ask($, 'load', { id: meta.id, version: meta.version, title: meta.title, view, rows: `${dir}/rows.json`, state, query, width })
}

/** A request about a card: when the runner does not hold the card (it started again, the session was resumed), the
 *  card is loaded from its copy and the request asked again. */
export async function askCard($: Engine, meta: CardMeta, op: string, body: Record<string, unknown>): Promise<Any> {
  const r = await ask($, op, { id: meta.id, ...body })
  if (!r?.missing) return r
  const width = Number(body.width) || ((await treeOf($, meta.id))?.width ?? cardWidth())
  const loaded = await loadCard($, meta, width)
  if (!loaded.ok) return loaded
  return op === 'draw' && !body.text ? loaded : ask($, op, { id: meta.id, ...body })
}

/** The runner's answer to an event of the person's: the new tree drawn, the state kept, and a failure line about the
 *  card gone; a failure on the card and in the failure line, since the person sees the card stop. */
export async function applyAnswer($: Engine, meta: CardMeta, r: Any, width?: number): Promise<void> {
  if (r?.ok) {
    const before = await treeOf($, meta.id)
    await setTree($, meta.id, { gen: meta.gen, width: width ?? before?.width ?? cardWidth(), tree: r.tree, pointer: !!r.pointer, seq: Number(r.seq) || 0 })
    if (typeof r.state === 'string') void saveState($, meta.id, meta.version, r.state, typeof r.query === 'string' ? r.query : null).catch(() => undefined)
    if (meta.error) await saveMeta($, { ...meta, error: null })
    await failCleared($, about(meta.id))
    return
  }
  const error = String(r?.error || 'the card did not answer')
  await saveMeta($, { ...meta, error })
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
  const metas: CardMeta[] = []
  for (const id of await seenNow($)) {
    if (shown.get(id) === false) continue
    const m = await metaOf($, id)
    if (m && m.version > 0 && m.keys.includes(key)) metas.push(m)
  }
  const focus = await focusNow($)
  return metas.find(m => m.id === focus) ?? metas.sort((a, b) => b.at - a.at)[0] ?? null
}

/** The card's frame: title, the Client that draws its tree, a failure, and the keys that reach it now. */
export async function frame($: Engine, e: Any, meta: CardMeta, note: string | null): Promise<Any> {
  const E = $.ui.resolve(e) as Any
  const width = cardWidth(e.viewport?.columns)
  const t = await treeOf($, meta.id)
  const focused = (await focusNow($)) === meta.id
  const search = await searchNow($)
  const current = t && t.gen === meta.gen ? t : null
  const f = faulted.get(meta.id)
  const fault = f && current && f.seq === current.seq ? f.reason : null
  // the title on a line of its own; under it, dim, where the card comes from when that is not plain from its place
  const from = [note, meta.version > 1 ? `version ${meta.version}` : ''].filter(Boolean).join(' · ')
  const rows: Any[] = [
    E.Text({ key: 'title', bold: true, wrap: 'wrap', children: meta.title }),
    ...(from ? [E.Text({ key: 'about', dimColor: true, wrap: 'truncate-end', children: from })] : []),
    ...(fault ? [] : [E.Client({
      key: `card-${meta.id}`, module: './client.tsx', width: current?.width ?? width,
      props: { tree: current?.tree ?? null, width: current?.width ?? width, need: current?.width === width ? '' : `${meta.gen}:${width}` },
    })]),
  ]
  if (fault) rows.push(E.Text({ key: 'fault', color: 'error', wrap: 'wrap', children: `× Claude Code could not draw this card: ${fault}` }))
  if (meta.error) rows.push(E.Text({ key: 'error', color: 'error', wrap: 'wrap', children: `× ${meta.error}` }))
  const mine: string[] = []
  for (const k of meta.keys) if ((await keyOwner($, k))?.id === meta.id) mine.push(k)
  const searching = search?.id === meta.id
  if (mine.length || searching) {
    const words = searching && !search.kept
      ? `search “${search.text}” · Enter keeps it · an empty prompt ends it`
      : [
          mine.some(k => k !== '/') ? `keys ${mine.filter(k => k !== '/').join(' ')} at an empty prompt` : '',
          mine.includes('/') ? (searching ? `search “${search!.text}” kept · / searches again` : '/ searches') : '',
        ].filter(Boolean).join(' · ')
    rows.push(E.Text({ key: 'keys', dimColor: true, wrap: 'truncate-end', children: words }))
  }
  return E.Box({ key: `frame-${meta.id}`, flexDirection: 'column', borderStyle: 'round', borderColor: focused ? 'claude' : undefined, borderDimColor: !focused, paddingX: 1, marginLeft: 2, width: width + 4, children: rows })
}

/** The card's Client failed on screen (Claude Code's ui.fault): its frame draws the reason in its place until the card
 *  has a newer tree, and the failure line says it until then. */
export async function clientFault($: Engine, id: string, reason: string): Promise<void> {
  const meta = await metaOf($, id)
  const t = await treeOf($, id)
  if (!meta || !t) return
  faulted.set(id, { seq: t.seq, reason: reason.slice(0, 200) })
  $.ui.invalidate('ui.render')
  failNotice($, `The card “${cut(meta.title, 40)}” could not be drawn: ${reason.slice(0, 120)}`, about(id))
}

/** The cards drawn under an answer, by the answer's row, oldest first. */
export function cardsUnder(row: string): string[] {
  return cardsAtNow(row)
}

/** A card's text copy as it draws now: what its newest version shows, at the width it is drawn at. */
export async function cardText($: Engine, id: string): Promise<string> {
  const meta = await metaOf($, id)
  if (!meta || meta.version < 1) return ''
  const t = await treeOf($, id)
  const r = await askCard($, meta, 'draw', { width: t?.width ?? cardWidth(), text: true })
  return r?.ok ? (r.lines as string[]).join('\n') : `(the card did not draw: ${r?.error ?? 'no answer'})`
}

/** The cards an answer row holds, framed, under it: those still anchored there (a card main drew a new version of
 *  stands at main's call). */
export async function framesUnder($: Engine, e: Any): Promise<Any[]> {
  const metas: CardMeta[] = []
  for (const id of await anchoredAt($, e.requestId)) {
    const meta = await metaOf($, id)
    if (meta && meta.version > 0 && meta.anchorRow === e.requestId) metas.push(meta)
  }
  if (metas.length) noteShown($, metas.map(m => m.id), e.props?.onScreen)
  const out: Any[] = []
  for (const meta of metas) out.push(await frame($, e, meta, 'drawn after you pressed v'))
  return out
}

// the keys in the order the person pressed them: each waits for the one before it, since the hooks of two quick keys
// run at the same time and their requests could reach the runner in the other order
let keys: Promise<unknown> = Promise.resolve()

/** A key at an empty prompt to the card it reaches, if any, after the keys pressed before it: the card's id, or null.
 *  `/` starts a search. */
export function cardKey($: Engine, key: string): Promise<string | null> {
  const done = keys.then(async () => {
    const meta = await keyOwner($, key)
    if (!meta) return null
    if (key === '/') {
      await setSearch($, { id: meta.id, text: '' })
      await applyAnswer($, meta, await askCard($, meta, 'query', { text: '' }))
    }
    await applyAnswer($, meta, await askCard($, meta, 'key', { key }))
    return meta.id
  })
  keys = done.catch(() => undefined)
  return done
}

/** The cards undo the keys they took last, one undo per key, after the keys pressed before. */
export function undoKeys($: Engine, ids: string[]): Promise<void> {
  const done = keys.then(async () => {
    const n = new Map<string, number>()
    for (const id of ids) n.set(id, (n.get(id) ?? 0) + 1)
    for (const [id, count] of n) {
      const meta = await metaOf($, id)
      if (meta) await applyAnswer($, meta, await askCard($, meta, 'undo', { n: count }))
    }
  })
  keys = done.catch(() => undefined)
  return done
}

/** The search's words as the prompt box holds them: the card's props.query; an empty box ends the search. */
export async function searchTyped($: Engine, text: string): Promise<void> {
  const search = await searchNow($)
  if (!search || search.kept) return
  const meta = await metaOf($, search.id)
  if (!meta) { await setSearch($, null); return }
  await setSearch($, text ? { id: meta.id, text } : null)
  await applyAnswer($, meta, await askCard($, meta, 'query', { text: text || null }))
}

/** Enter while a search is typed: the card keeps the search. Answers the line Claude Code shows for the prompt it does
 *  not send. */
export async function keepSearch($: Engine): Promise<string> {
  const search = await searchNow($)
  if (!search) return ''
  await setSearch($, { ...search, kept: true })
  const meta = await metaOf($, search.id)
  return `The card “${cut(meta?.title ?? '', 40)}” keeps the search “${cut(search.text, 40)}”; nothing was sent to Claude.`
}

/** Claude Code put a prompt a hook did not send back in the box: when it is the kept search's words, the box is
 *  cleared, so the next key reaches the card and the next prompt starts empty. */
export async function searchRestored($: Engine, text: string): Promise<void> {
  const search = await searchNow($)
  if (search?.kept && text === search.text) await $.prompt.fill({ text: '', mode: 'replace' })
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
  if (typeof ev.press === 'number') return askCard($, meta, 'press', { button: ev.press })
  if (ev.pointer && typeof ev.pointer === 'object') {
    const at = (v: Any) => ({ x: Math.trunc(Number(v?.x) || 0), y: Math.trunc(Number(v?.y) || 0) })
    if (!(await treeOf($, meta.id))?.pointer) return null
    return askCard($, meta, 'pointer', { down: at(ev.pointer.down), up: at(ev.pointer.up), button: String(ev.pointer.button || 'left') })
  }
  return null
}

/** A Client's post: the events it has not had an answer for, each handled once, in order. After a press or a click,
 *  the card takes the keys at an empty prompt first. Answers the Client's next props, with the last event handled. */
export async function cardPost($: Engine, id: string, data: Any): Promise<Any> {
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
    if (r?.r) await applyAnswer($, meta, r.r, r.width)
    else if (r) await applyAnswer($, meta, r)
  }
  const t = await treeOf($, id)
  return t ? { props: { tree: t.tree, width: t.width, ack: { [client]: last } } } : {}
}
