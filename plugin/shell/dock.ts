// dock.ts: Coverage (what Claude read of the folder, panes/coverage.js) and the label viewer (panes/labels.js), which
// open in the side panel (side.ts openSide) as threads: the pane at the top, its thread's conversation under it, the
// input bar at the bottom, so "why was events.jsonl not read?" is asked from Coverage itself. The bar's right side names
// them: `r coverage 3/7 files` (the folder's files Claude touched: read, searched, counted or computed over) with a
// small bar of the folder's file types filled by the same share, and `l 2 labels` once the folder has labels; a click
// on either, or its key (r, l) from the empty prompt, opens its pane, and the same again closes it. This module is what
// the side panel does not do for them:
//
//   data   the coverage (`thimble coverage --json`, this session's, read again on open, after each turn, and a moment
//          after each of Claude's tool calls while it works, so the bar's coverage follows the work) and the labels
//          (`thimble label --json`), held here; what a program wants on demand: a file's lines around a read range,
//          and a page of a label's records (`thimble label NAME --records …`)
//   acts   a label value the person checks in the label panel is their check (labels.ts check), as in the card detail;
//          when the panel closes, Claude hears of the checks in a row of its own (labels.ts checksDone, detail.tsx);
//          `where Claude made it` scrolls the conversation to the label's card
//   bar    the two counts, their clicks and their keys (r and l act once a moment has passed with no letter after them,
//          as t does: a letter makes them the start of a word)
//
// It reads, as the person: nothing it runs counts as what Claude read (shell.tsx leanEnv), and it makes no model call.
import type { EngineInterface, Register } from 'claude-code'

import { barCells, typeMix } from '../panes/coverage.js'
import { termColor } from '../draw/palette.js'
import { detailIsOpen, PANE as PANEL } from './detail'
import { check as checkLabel, labelGen } from './labels'
import { instance, patchPaneState, redraw } from './panes'
import { currentTheme, goToCard, leanEnv, paneWhere, recount } from './shell'
import { threadList } from './thread'
import { openSide, sideBack, sideNow } from './side'
import { sessionKey } from '../hooks/conversation'
import { keyColor } from './view'

type Engine = EngineInterface
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
export type Dock = 'coverage' | 'labels'
/** The key that opens each from the empty prompt, as the bar names it. */
export const DOCK_KEY: Record<Dock, string> = { coverage: 'r', labels: 'l' }
/** The cells of the small type bar beside the coverage share in thimble's bar. */
export const MIX_CELLS = 8

// the module's memory: what each pane shows, and the pages of records read
const held = {
  coverage: { cov: null as Any, loading: false, error: null as string | null, gen: 0, since: 0 },
  labels: { list: null as Any[] | null, loading: false, error: null as string | null, gen: 0, since: 0 },
}
/** A read still running after this long (one lost with a reload of the module) no longer holds back the next. */
const READ_MS = 30000
const pages = new Map<string, Any>()
const PAGES_KEPT = 40

/** The folder the panes read: the one under analysis, else the session's. */
async function rootOf($: Engine): Promise<string> {
  return ((await paneWhere($)).root ?? String(await $.session.cwd())).replace(/\/+$/, '')
}

async function thimble($: Engine, root: string, args: string[], env?: Record<string, string>): Promise<{ ok: boolean; out: string; err: string }> {
  const dir = $.plugin.root.replace(/\/+$/, '')
  const r = await $.process.run([`${dir}/bin/thimble`, ...args], { cwd: root, env: env ?? (await leanEnv($, root)), timeoutMs: 90000 })
  return { ok: (r.exitCode ?? 1) === 0, out: String(r.stdout || ''), err: String(r.stderr || '') }
}

/** Whether the side panel shows this pane now. */
export async function dockShown($: Engine, pane: Dock): Promise<boolean> {
  if (!detailIsOpen()) return false
  const v = await sideNow($)
  return v?.kind === 'pane' && v.pane === pane
}

/** Draw the pane again (its program reads the stores anew), while the side panel shows it: a read that ends after
 *  the panel closed draws nothing (the pane reads the stores when it opens). */
async function again($: Engine, pane: Dock): Promise<void> {
  if (!(await dockShown($, pane))) return
  await redraw($, instance(pane, {}))
}

// ------------------------------------------------------------------------------------------------ data

/** This session's coverage, read again: the pane shows the last while it reads. */
export async function readCoverage($: Engine): Promise<void> {
  const h = held.coverage
  const now = Number(await $.clock.now())
  if (h.loading && now - h.since < READ_MS) return
  h.loading = true
  h.since = now
  await again($, 'coverage')
  try {
    const root = await rootOf($)
    // this session's reads, so the session's own key (as the bar's count reads it)
    const r = await thimble($, root, ['coverage', '--json'], { THIMBLE_ROOT: root, THIMBLE_SESSION: await sessionKey($) })
    try {
      h.cov = JSON.parse(r.out)
      h.error = null
      h.gen++
    } catch {
      h.error = (r.err || r.out).trim().split('\n').slice(-1)[0]?.slice(0, 200) || 'thimble coverage gave nothing'
    }
  } catch (err) {
    h.error = String((err as Error)?.message || err).slice(0, 200)
  } finally {
    h.loading = false
    await again($, 'coverage')
  }
}

/** The coverage the bar's count read after a turn (shell.tsx recount): the pane shows it, and the small type bar is
 *  made from it. */
export function noteCoverage(got: Any): { tone: string; seen: boolean; n: number }[] {
  if (got && Array.isArray(got.files)) { held.coverage.cov = got; held.coverage.error = null; held.coverage.gen++ }
  return Array.isArray(got?.types) ? barCells(typeMix(got.types), MIX_CELLS) : []
}

/** The folder's labels, read again. */
export async function readLabels($: Engine): Promise<void> {
  const h = held.labels
  const now = Number(await $.clock.now())
  if (h.loading && now - h.since < READ_MS) return
  h.loading = true
  h.since = now
  await again($, 'labels')
  try {
    const r = await thimble($, await rootOf($), ['label', '--json'])
    try {
      const v = JSON.parse(r.out)
      h.list = Array.isArray(v) ? v : []
      h.error = null
      h.gen++
    } catch {
      h.error = (r.err || r.out).trim().split('\n').slice(-1)[0]?.replace(/^thimble label: /, '').slice(0, 200) || 'thimble label gave nothing'
    }
  } catch (err) {
    h.error = String((err as Error)?.message || err).slice(0, 200)
  } finally {
    h.loading = false
    await again($, 'labels')
  }
}

/** How many labels the folder has (their files in thimble/labels), for the bar. */
export async function countLabels($: Engine, root: string | null): Promise<number> {
  if (!root) return 0
  try {
    const xs = await $.fs.list(`${root.replace(/\/+$/, '')}/thimble/labels`)
    return xs.filter(x => x.name.endsWith('.json') && !x.name.startsWith('.')).length
  } catch {
    return 0
  }
}

/** A store a pane reads (shell.tsx paneStore). The pane keys its data by the store as JSON, which for the coverage of a
 *  large folder is long: each store says itself as JSON by its generation alone, so a key is cheap and changes only
 *  when what it holds changes. A pane with nothing in hand (a reload of this module lost it) reads it again. */
export async function dockStore($: Engine, kind: string): Promise<unknown> {
  const said = (h: { gen: number; loading: boolean; error: string | null }, more: Record<string, unknown> = {}) => ({ toJSON: () => ({ gen: h.gen, loading: h.loading, error: h.error, ...more }) })
  if (kind === 'coverage' && !held.coverage.cov && !held.coverage.loading && !held.coverage.error) $.clock.after(0, () => { void readCoverage($) })
  if (kind === 'labels' && !held.labels.list && !held.labels.loading && !held.labels.error) $.clock.after(0, () => { void readLabels($) })
  // whether the pane's thread has a conversation, which the side panel draws under it: the pane leaves it room
  const chat = threadList().some(t => (t.scope as Any)?.pane === kind && t.turns.length > 0)
  if (kind === 'coverage') return { ...held.coverage, chat, ...said(held.coverage, { chat }) }
  if (kind === 'labels') { const checks = await labelGen($); return { ...held.labels, checks, chat, ...said(held.labels, { checks, chat }) } }
  return undefined
}

/** What a pane's program wants on demand (shell.tsx paneWant): a file's lines, a page of a label's records. */
export async function dockWant($: Engine, request: Any): Promise<unknown> {
  const root = await rootOf($)
  if (typeof request?.lines === 'string') {
    const rel = String(request.lines)
    if (rel.startsWith('/') || rel.split('/').includes('..')) return { error: 'that file is outside the folder' }
    const from = Math.max(1, Math.floor(Number(request.from) || 1))
    const to = Math.max(from, Math.min(from + 400, Math.floor(Number(request.to) || from)))
    const r = await $.process.run(['awk', '-v', `a=${from}`, '-v', `b=${to}`, 'NR>=a{print substr($0,1,400)} NR>=b{exit}', `${root}/${rel}`], { cwd: root, timeoutMs: 20000 })
    if ((r.exitCode ?? 1) !== 0) return { error: String(r.stderr || 'the file could not be read').trim().slice(0, 200) }
    const lines = String(r.stdout || '').replace(/\n$/, '').split('\n')
    return { lines: lines.length === 1 && lines[0] === '' && to > from ? [] : lines }
  }
  if (typeof request?.records === 'string') {
    const key = JSON.stringify([request.records, request.value, request.at, request.n, request.gen])
    const kept = pages.get(key)
    if (kept) return kept
    const args = ['label', String(request.records), '--records', String(request.value ?? '*'), '--at', String(Math.max(0, Number(request.at) || 0)), '--count', String(Math.max(1, Number(request.n) || 20)), '--json']
    const r = await thimble($, root, args)
    let v: Any
    try { v = JSON.parse(r.out) } catch { v = { error: (r.out || r.err).trim().split('\n').slice(-1)[0]?.replace(/^thimble label: /, '').slice(0, 200) || 'thimble label gave nothing' } }
    // (kept by the checks made so far, so a check reads the page again; the newest last, a few dozen at most)
    pages.delete(key)
    pages.set(key, v)
    while (pages.size > PAGES_KEPT) pages.delete(pages.keys().next().value as string)
    return v
  }
  return undefined
}

/** What a pane's program asks of the host (shell.tsx paneAction): check a record's value. */
export async function dockAction($: Engine, pane: Dock, a: Record<string, unknown>): Promise<string | boolean | void> {
  // the label's card in the conversation, where Claude made the label
  if (String(a.do || '') === 'reveal' && typeof a.card === 'string') {
    const row = (await $.state.get({ plugin: 'thimble', key: 'where', id: a.card })).value as string | undefined
    if (!row) return 'The card where Claude made this label is not in this conversation.'
    await goToCard($, row, a.card)
    return
  }
  if (String(a.do || '') === 'check' && pane === 'labels') {
    const said = await checkLabel($, await rootOf($), a)
    // the counts changed: the list read again (and the pages, by the checks made)
    $.clock.after(0, () => { void readLabels($) })
    return said || undefined
  }
  return false
}

// ------------------------------------------------------------------------------------------------ open and close

/** The pane in the side panel, over what the panel shows (esc goes back to it), its data read again. */
export async function openDock($: Engine, pane: Dock): Promise<boolean> {
  if (pane === 'coverage') $.clock.after(0, () => { void readCoverage($) })
  else {
    $.clock.after(0, () => { void readLabels($) })
    // the bar's count opens the folder's labels (one label alone opens on itself)
    await patchPaneState($, 'labels', {}, { open: null, filter: null, rec: 0, at: null, from: null, def: false })
  }
  return openSide($, { pane, args: {} }, { push: detailIsOpen() })
}

/** One label in the side panel, its records filtered to `value` when one is given: from the row beside a card or an
 *  answer (labeluse.ts). Esc goes back to what the panel showed before, else closes it. */
export async function openLabel($: Engine, name: string, value: string | null = null): Promise<boolean> {
  $.clock.after(0, () => { void readLabels($) })
  await patchPaneState($, 'labels', {}, { open: name, filter: value, rec: 0, at: null, from: null, def: false })
  return openSide($, { pane: 'labels', args: {} }, { push: detailIsOpen() })
}

/** The pane out of the side panel: back to what the panel showed before, else the panel closes. */
export async function closeDock($: Engine, pane: Dock): Promise<void> {
  if (!(await dockShown($, pane))) return
  if (await sideBack($)) return
  await $.ui.close({ id: PANEL }).catch(() => undefined)
}

/** A press on the bar's count, or its key: open the pane, or close it when the panel shows it. */
export async function toggleDock($: Engine, pane: Dock): Promise<void> {
  if (await dockShown($, pane)) await closeDock($, pane)
  else await openDock($, pane)
}

// ------------------------------------------------------------------------------------------------ keys

/** The pane a key from the empty prompt opens at rest: r Coverage, l the labels, when the bar names them (`named`).
 *  The shell opens it once a moment has passed with no letter after the key (a letter makes it the start of a word),
 *  as t opens the thread list. */
export function restPane(k: string, named: { cov: boolean; labels: boolean }): Dock | null {
  return k === DOCK_KEY.coverage && named.cov ? 'coverage' : k === DOCK_KEY.labels && named.labels ? 'labels' : null
}

// ------------------------------------------------------------------------------------------------ the bar's counts

// (bare: drawn without its key, which does something else now: shell.tsx)
type Count = { id: string; text: string; bare?: boolean; bright: boolean }
type Counts = { cov: number; covFiles?: number; covTouched?: number; labels?: number; mix?: { tone: string; seen: boolean; n: number }[] }

/** The bar's counts of the two panes, as fitBar measures them: `r coverage 3/7 files ████████` and `l 2 labels`. The
 *  coverage is the files Claude touched of the folder's files, each file once whatever its unit: some of it entered
 *  Claude's context, or a query, a rule, a search, a count or a program went over it (0 means Claude looked at no file
 *  at all); how much of each file, and how it was touched, are the pane's to say. */
export function dockCounts(c: Counts, percent: (x: number) => string): [string, number, string][] {
  const mix = (c.mix || []).reduce((s, x) => s + x.n, 0)
  const all = c.covFiles ?? 0
  const words = all ? `${(c.covTouched ?? 0).toLocaleString('en-US')}/${all.toLocaleString('en-US')} ${all === 1 ? 'file' : 'files'}` : percent(c.cov)
  return [
    ['cov', c.cov, `${DOCK_KEY.coverage} coverage ${words}${mix ? ` ${'█'.repeat(mix)}` : ''}`],
    ['labels', c.labels ?? 0, `${DOCK_KEY.labels} ${c.labels === 1 ? '1 label' : `${(c.labels ?? 0).toLocaleString('en-US')} labels`}`],
  ]
}

/** One count drawn: its key in the key's color, its words, the coverage's small type bar in the types' colors (seen
 *  bright, the rest pale), the whole a press that opens its pane. */
export function dockCountEl($: Engine, els: Any, x: Count, c: Counts, press: boolean): Any {
  const { Button, Text } = els
  const theme = currentTheme()
  const pane: Dock = x.id === 'cov' ? 'coverage' : 'labels'
  const key = DOCK_KEY[pane]
  const words = (x.bare ? x.text : x.text.slice(key.length + 1)).replace(/ █+$/, '')
  const kids: Any[] = [
    ...(x.bare ? [] : [Text({ key: `ck-${x.id}`, color: keyColor(key, theme), ...(x.bright ? { bold: true } : {}), children: key })]),
    Text({ key: `cw-${x.id}`, ...(x.bright ? { bold: true } : { dimColor: true }), children: x.bare ? words : ` ${words}` }),
  ]
  if (pane === 'coverage' && c.mix?.length) {
    kids.push(Text({ key: 'cm-gap', children: ' ' }))
    c.mix.forEach((m, i) => kids.push(Text({ key: `cm-${i}`, color: termColor(m.seen ? m.tone : `${m.tone}-faint`, theme) ?? 'inactive', children: '█'.repeat(m.n) })))
  }
  if (!press) return Text({ key: `count-${x.id}`, children: kids })
  return Button({ key: `count-${x.id}`, plain: true, label: pane === 'coverage' ? 'open Coverage: what Claude saw' : 'open the labels', onPress: () => toggleDock($, pane), children: kids })
}

// ------------------------------------------------------------------------------------------------ coverage while Claude works

/** How long after a tool call the bar's coverage is counted again, and how often at most. */
const COVER_AFTER_MS = 1500
const COVER_EVERY_MS = 5000
let coverAt = 0
let coverWaiting = false

/** The bar's coverage counted again a moment after a call, at most once every few seconds (the last call of a burst
 *  is counted too). */
function coverSoon($: Engine, now: number): void {
  if (coverWaiting) return
  coverWaiting = true
  const wait = coverAt ? Math.max(COVER_AFTER_MS, coverAt + COVER_EVERY_MS - now) : COVER_AFTER_MS
  $.clock.after(wait, () => {
    coverWaiting = false
    void $.clock.now().then(t => { coverAt = Number(t) }).catch(() => undefined)
    void recount($, { coverage: true }).catch(() => undefined)
  })
}

export function registerDock(on: Parameters<Register>[0]): void {
  // what Claude reads while it works counts at once: the bar's coverage follows each call that can read the folder (a
  // Read, a search, a command), not only the end of the turn
  on('tool.call', { tool: /^(Read|Grep|Glob|Bash)$/ }, async ($, e, next) => {
    const r = await next(e)
    try { coverSoon($, Number(await $.clock.now())) } catch { /* the turn's end counts it */ }
    return r
  }).catch(($, e, next) => next(e))
}

/** For tests: the module's memory, cleared. */
export function resetDock(): void {
  coverAt = 0
  coverWaiting = false
  held.coverage = { cov: null, loading: false, error: null, gen: 0, since: 0 }
  held.labels = { list: null, loading: false, error: null, gen: 0, since: 0 }
  pages.clear()
}
