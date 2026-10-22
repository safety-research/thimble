// draw.ts: cards on screen. A card draws in a frame under the call that first drew it, in its newest version; a card
// the designer fork drew draws under the answer v was pressed on. Inside the frame, the one Client module
// (client.tsx) draws the tree the runner made of the view. The person's keys, clicks and `/` search go to the runner,
// and its new tree is drawn.
//
//   frame         the card's frame: its title, the Client, a failure, and, while the card takes keys, its keys
//   framesUnder   the frames of the cards drawn under an answer
//   askCard       a request to the runner about a card; a card the runner does not hold is loaded from its copy first
//   applyAnswer   the runner's answer to an event: the new tree on screen, the state on disk, a failure said
//   cardKey       a key at an empty prompt goes to the focused card when the card lists it; `/` starts a search typed
//   searchTyped   in the prompt box, whose words reach the card as props.query at each keystroke; Enter keeps it
//   keepSearch    (keepSearch), and the kept words leave the box at the next edit (keptSearchEdit)
//   cardPost      what a card's Client sends: Button presses and clicks
//   cardsUnder    the cards drawn under an answer (for v)
//   cardText      a card's text copy as it draws now (for v)
//
// The width a card is drawn at is the screen's columns less its frame; a resize draws it again at the new width.
import type { EngineInterface } from 'claude-code'

import { failNotice } from '../bar/fix'
import { ask } from './ask'
import { type CardMeta, anchoredAt, cardsAtNow, focusNow, metaOf, readState, saveMeta, saveState, searchNow, setFocus, setSearch, setTree, treeOf, versionDir } from './store'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Columns the frame takes beside the card: its indent (2), border (2) and padding (2), and 2 left free at the right. */
const FRAME = 8
const MIN_WIDTH = 20

let columnsSeen = 0
// the drawings asked for now, and the ones that failed (by card, version and width), which are not asked for again
// until the card changes or the screen's width does
const pending = new Set<string>()
const failed = new Set<string>()
// the cards whose Client failed on screen, by card and version: their frame says why in its place (for this load of the
// module: a resumed session tries again)
const faulted = new Map<string, string>()

/** The screen's width, as the last drawing of a message or a card saw it. */
export function noteColumns(columns: number | undefined): void {
  if (columns && columns > 0) columnsSeen = columns
}

export function cardWidth(columns?: number): number {
  return Math.max(MIN_WIDTH, (columns || columnsSeen || 100) - FRAME)
}

const cut = (s: string, n: number) => ([...s].length <= n ? s : `${[...s].slice(0, n - 1).join('')}…`)

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

/** The runner's answer to an event of the person's: the new tree drawn, the state kept; a failure on the card and in
 *  the failure line, since the person sees the card stop. */
export async function applyAnswer($: Engine, meta: CardMeta, r: Any, width?: number): Promise<void> {
  if (r?.ok) {
    const before = await treeOf($, meta.id)
    await setTree($, meta.id, { gen: meta.gen, width: width ?? before?.width ?? cardWidth(), tree: r.tree, pointer: !!r.pointer })
    if (typeof r.state === 'string') void saveState($, meta.id, meta.version, r.state, typeof r.query === 'string' ? r.query : null).catch(() => undefined)
    if (meta.error) await saveMeta($, { ...meta, error: null })
    return
  }
  const error = String(r?.error || 'the card did not answer')
  await saveMeta($, { ...meta, error })
  failNotice($, `The card “${cut(meta.title, 40)}” failed: ${error}`)
}

/** Draw a card again at a width (a resize, a resumed session), once per card, version and width at a time. */
function redrawLater($: Engine, meta: CardMeta, width: number): void {
  const k = `${meta.id}:${meta.gen}:${width}`
  if (pending.has(k) || failed.has(k)) return
  pending.add(k)
  $.clock.after(0, () => {
    void (async () => {
      try {
        const r = await askCard($, meta, 'draw', { width })
        if (!r?.ok) failed.add(k)
        await applyAnswer($, meta, r, width)
      } finally {
        pending.delete(k)
      }
    })()
  })
}

/** The card's frame: title, the Client that draws its tree, a failure, and its keys while it takes them. */
export async function frame($: Engine, e: Any, meta: CardMeta, note: string | null): Promise<Any> {
  const E = $.ui.resolve(e) as Any
  const width = cardWidth(e.viewport?.columns)
  const t = await treeOf($, meta.id)
  const focused = (await focusNow($)) === meta.id
  const search = await searchNow($)
  if (!t || t.gen !== meta.gen || t.width !== width) redrawLater($, meta, width)
  const fault = faulted.get(`${meta.id}:${meta.gen}`)
  const drawn = t && t.gen === meta.gen && !fault
  // the title on a line of its own; under it, dim, where the card comes from when that is not plain from its place
  const about = [note, meta.version > 1 ? `version ${meta.version}${note ? '' : ', from a later call'}` : ''].filter(Boolean).join(' · ')
  const rows: Any[] = [
    E.Text({ key: 'title', bold: true, wrap: 'wrap', children: meta.title }),
    ...(about ? [E.Text({ key: 'about', dimColor: true, wrap: 'truncate-end', children: about })] : []),
    drawn
      ? E.Client({ key: `card-${meta.id}`, module: './client.tsx', props: { tree: t!.tree, width: t!.width }, width: t!.width })
      : E.Text({ key: 'wait', dimColor: true, children: meta.error || fault ? '' : 'drawing…' }),
  ]
  if (fault) rows.push(E.Text({ key: 'fault', color: 'error', wrap: 'wrap', children: `× Claude Code could not draw this card: ${fault}` }))
  if (meta.error) rows.push(E.Text({ key: 'error', color: 'error', wrap: 'wrap', children: `× ${meta.error}` }))
  if (focused && (meta.keys.length || search?.id === meta.id)) {
    const words = search?.id === meta.id && !search.kept
      ? `searching “${search.text}” · Enter keeps it · an empty prompt ends it`
      : [
          meta.keys.some(k => k !== '/') ? `keys ${meta.keys.filter(k => k !== '/').join(' ')} at an empty prompt` : '',
          meta.keys.includes('/') ? '/ searches' : '',
          search?.id === meta.id ? `kept: “${search.text}”` : '',
        ].filter(Boolean).join(' · ')
    rows.push(E.Text({ key: 'keys', dimColor: true, wrap: 'truncate-end', children: words }))
  }
  return E.Box({ key: `frame-${meta.id}`, flexDirection: 'column', borderStyle: 'round', borderColor: focused ? 'claude' : undefined, borderDimColor: !focused, paddingX: 1, marginLeft: 2, width: width + 4, children: rows })
}

/** The card's Client failed on screen (Claude Code's ui.fault): its frame draws the reason in its place from now on,
 *  and the failure line says it. A new version of the card is drawn again. */
export async function clientFault($: Engine, id: string, reason: string): Promise<void> {
  const meta = await metaOf($, id)
  if (!meta) return
  faulted.set(`${id}:${meta.gen}`, reason.slice(0, 200))
  $.ui.invalidate('ui.render')
  failNotice($, `The card “${cut(meta.title, 40)}” could not be drawn: ${reason.slice(0, 120)}`)
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

/** The cards an answer row holds, framed, under it. */
export async function framesUnder($: Engine, e: Any): Promise<Any[]> {
  const out: Any[] = []
  for (const id of await anchoredAt($, e.requestId)) {
    const meta = await metaOf($, id)
    if (meta && meta.version > 0) out.push(await frame($, e, meta, 'drawn after you pressed v'))
  }
  return out
}

/** A key at an empty prompt: the focused card's, when it lists it. `/` starts a search. */
export async function cardKey($: Engine, key: string): Promise<boolean> {
  const id = await focusNow($)
  const meta = id ? await metaOf($, id) : null
  if (!meta || meta.version < 1 || !meta.keys.includes(key)) return false
  if (key === '/') {
    await setSearch($, { id: meta.id, text: '' })
    await applyAnswer($, meta, await askCard($, meta, 'query', { text: '' }))
  }
  await applyAnswer($, meta, await askCard($, meta, 'key', { key }))
  return true
}

/** The search's words as the prompt box holds them: the card's props.query; an empty box ends the search. */
export async function searchTyped($: Engine, text: string): Promise<void> {
  const search = await searchNow($)
  if (!search) return
  const meta = await metaOf($, search.id)
  if (!meta) { await setSearch($, null); return }
  await setSearch($, text ? { id: meta.id, text } : null)
  await applyAnswer($, meta, await askCard($, meta, 'query', { text: text || null }))
}

/** Enter while a search runs: the card keeps the search, and the prompt box is the person's again. Claude Code keeps a
 *  prompt a hook did not let through in the box; the kept search's words leave it at the person's next edit
 *  (keptSearchEdit). */
export async function keepSearch($: Engine): Promise<string> {
  const search = await searchNow($)
  if (!search) return ''
  await setSearch($, { ...search, kept: true })
  const meta = await metaOf($, search.id)
  return `The card “${cut(meta?.title ?? '', 40)}” keeps the search “${cut(search.text, 40)}”.`
}

/** The first edit after a kept search: its words leave the prompt box, and what the person typed starts the prompt. */
export async function keptSearchEdit($: Engine, typed: string): Promise<{ text: string; cursor: number }> {
  await setSearch($, null)
  return { text: typed, cursor: typed.length }
}

// the last event handled, by the Client instance that sent it
const handled = new Map<string, number>()

/** One event of a Client's: a Button press or a click. */
async function clientEvent($: Engine, meta: CardMeta, ev: Any): Promise<Any> {
  if (typeof ev.press === 'number') return askCard($, meta, 'press', { button: ev.press })
  if (ev.pointer && typeof ev.pointer === 'object') {
    const at = (v: Any) => ({ x: Math.trunc(Number(v?.x) || 0), y: Math.trunc(Number(v?.y) || 0) })
    if (!(await treeOf($, meta.id))?.pointer) return null
    return askCard($, meta, 'pointer', { down: at(ev.pointer.down), up: at(ev.pointer.up), button: String(ev.pointer.button || 'left') })
  }
  return null
}

/** A Client's post: the events it has not had an answer for, each handled once, in order. The card takes the keys at
 *  an empty prompt from then on. Answers the Client's next props, with the last event handled. */
export async function cardPost($: Engine, id: string, data: Any): Promise<Any> {
  const meta = await metaOf($, id)
  if (!meta || meta.version < 1 || !data || typeof data !== 'object' || !Array.isArray(data.events)) return {}
  const client = String(data.client ?? '')
  const from = `${id}:${client}`
  let last = handled.get(from) ?? 0
  await setFocus($, id)
  for (const ev of data.events) {
    const n = Number(ev?.n)
    if (!Number.isInteger(n) || n <= last) continue
    last = n
    handled.set(from, n)
    const r = await clientEvent($, meta, ev)
    if (r) await applyAnswer($, meta, r)
  }
  const t = await treeOf($, id)
  return t ? { props: { tree: t.tree, width: t.width, ack: { [client]: last } } } : {}
}

