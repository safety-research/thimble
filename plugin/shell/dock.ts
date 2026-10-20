// dock.ts: Coverage (what Claude read of the folder, panes/coverage.js) and the label viewer (panes/labels.js), which
// open in the side panel (side.ts openSide) as threads: the pane at the top, its thread's conversation under it, the
// input bar at the bottom, so "why was events.jsonl not read?" is asked from Coverage itself. The bar's right side names
// them: `seen 12%` (the share of the folder's rows that entered Claude's context) with a small bar of the folder's file
// types, and `2 labels` once the folder has labels; a click
// on either, or its key (r, l) from the empty prompt, opens its pane, and the same again closes it. This module is what
// the side panel does not do for them:
//
//   data   the coverage (`thimble coverage --json`, this session's, read again on open and after each turn) and the
//          labels (`thimble label --json`), held here; what a program wants on demand: a file's lines around a read
//          range, and a page of a label's records (`thimble label NAME --records …`)
//   acts   a label value checked with the number keys is the person's check (labels.ts check), as in the card detail;
//          when the panel closes, Claude hears of the checks in a row of its own (labels.ts checksDone, detail.tsx)
//   bar    the two counts, their clicks and their keys (r and l act once a moment has passed with no letter after them,
//          as t does: a letter makes them the start of a word)
//
// It reads, as the person: nothing it runs counts as what Claude read (shell.tsx leanEnv), and it makes no model call.
import type { EngineInterface } from 'claude-code'

import { barCells, typeMix } from '../panes/coverage.js'
import { termColor } from '../draw/palette.js'
import { detailIsOpen, PANE as PANEL } from './detail'
import { check as checkLabel, labelGen } from './labels'
import { instance, redraw } from './panes'
import { currentTheme, leanEnv, paneWhere } from './shell'
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

/** Draw the pane again (its program reads the stores anew). */
async function again($: Engine, pane: Dock): Promise<void> {
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
  else $.clock.after(0, () => { void readLabels($) })
  return openSide($, { pane, args: {} }, { push: detailIsOpen() })
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
type Counts = { cov: number; labels?: number; mix?: { tone: string; seen: boolean; n: number }[] }

/** The bar's counts of the two panes, as fitBar measures them: `r seen 12% ████████` and `l 2 labels`. The coverage
 *  is one word and one number, the share of the folder's rows that entered Claude's context ("seen", the kernel's word:
 *  "read" was what a query or a rule computed over too); what was only computed over, and the files touched, are the
 *  pane's to say. */
export function dockCounts(c: Counts, percent: (x: number) => string): [string, number, string][] {
  const mix = (c.mix || []).reduce((s, x) => s + x.n, 0)
  return [
    ['cov', c.cov, `${DOCK_KEY.coverage} seen ${percent(c.cov)}${mix ? ` ${'█'.repeat(mix)}` : ''}`],
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

/** For tests: the module's memory, cleared. */
export function resetDock(): void {
  held.coverage = { cov: null, loading: false, error: null, gen: 0, since: 0 }
  held.labels = { list: null, loading: false, error: null, gen: 0, since: 0 }
  pages.clear()
}
